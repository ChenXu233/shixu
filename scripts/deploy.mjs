#!/usr/bin/env node
/**
 * 一键发布：构建 → 打包 → 传上去 → 装进容器 → 重启 → 报地址。
 *
 * 之前这五步全靠手工，顺序错一步就是「装了个旧包」而没人发现。
 * 现在一条命令，失败就非零退出，不留半成品。
 *
 * 用法：
 *   node scripts/deploy.mjs --ssh "xs/华理内网服务器" --container harness-dsh-dev
 *   node scripts/deploy.mjs --check          # 只验能不能连上
 *
 * 目标也可以走环境变量：DEPLOY_SSH / DEPLOY_CONTAINER / DEPLOY_PROFILE。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const opts = { build: true, dry: false, check: false }
for (let i = 0; i < argv.length; i += 1) {
  const flag = argv[i]
  if (flag === '--no-build') opts.build = false
  else if (flag === '--dry-run') opts.dry = true
  else if (flag === '--check') opts.check = true
  else if (flag.startsWith('--')) opts[flag.slice(2)] = argv[(i += 1)]
}

const target = {
  ssh: opts.ssh ?? process.env.DEPLOY_SSH,
  container: opts.container ?? process.env.DEPLOY_CONTAINER,
  profile: opts.profile ?? process.env.DEPLOY_PROFILE ?? 'web',
}

if (target.ssh === undefined || target.container === undefined) {
  console.error('缺目标：--ssh <ssh 别名> 与 --container <容器名>（或 DEPLOY_SSH / DEPLOY_CONTAINER）')
  process.exit(2)
}

/** 跑一条本地命令，失败就带着输出退出。 */
function local(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.quiet ? 'pipe' : 'inherit',
    cwd: options.cwd,
    encoding: 'utf8',
    // 只有 pnpm 需要 shell（Windows 上是 .cmd）；ssh / scp / git 走 shell 会被 cmd 的引号规则改坏参数。
    shell: options.shell ?? false,
  })
  if (result.status !== 0) {
    if (options.quiet) console.error(result.stdout ?? '', result.stderr ?? '')
    throw new Error(`${command} ${args.join(' ')} 退出码 ${result.status}`)
  }
  return result.stdout ?? ''
}

/** 在远端跑一条命令，返回 stdout。 */
function remote(command, { quiet = false } = {}) {
  const result = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', target.ssh, command], { encoding: 'utf8' })
  if (result.status !== 0) {
    if (!quiet) console.error(result.stdout ?? '', result.stderr ?? '')
    throw new Error(`远端命令失败：${command}`)
  }
  return result.stdout ?? ''
}

const hash = local('git', ['rev-parse', '--short', 'HEAD'], { quiet: true }).trim()
const tarballName = `shixu-channel-${hash}.tgz`
const remotePath = `/tmp/${tarballName}`

console.log(`→ 目标 ${target.ssh} / ${target.container}（profile ${target.profile}），提交 ${hash}`)

if (opts.check) {
  const info = remote('echo ok; docker ps --filter name=^' + target.container + '$ --format "{{.Names}} {{.Status}}"')
  console.log(info.trim())
  process.exit(0)
}

if (opts.dry) {
  console.log('→ dry-run：只打印计划，不做任何改动')
  process.exit(0)
}

if (opts.build) {
  console.log('→ 构建')
  local('pnpm', ['-r', 'build'], { shell: process.platform === 'win32' })
}

console.log('→ 打包')
const pkg = JSON.parse(readFileSync(join(process.cwd(), 'packages', 'channel', 'package.json'), 'utf8'))
local('pnpm', ['pack'], { cwd: join(process.cwd(), 'packages', 'channel'), quiet: true, shell: process.platform === 'win32' })
const packed = join(process.cwd(), 'packages', 'channel', `${pkg.name}-${pkg.version}.tgz`)
if (!existsSync(packed)) throw new Error(`没找到打包产物：${packed}`)

console.log(`→ 传上去（${tarballName}）`)
// 用 ssh + cat 而不是 scp：别名里带斜杠时 scp 会把它当成两个本地路径。
const uploaded = spawnSync('ssh', ['-o', 'BatchMode=yes', target.ssh, `cat > ${remotePath}`], { input: readFileSync(packed) })
if (uploaded.status !== 0) throw new Error(`上传失败：${uploaded.stderr ?? ''}`)

console.log('→ 装进容器')
remote(
  [
    `docker cp ${remotePath} ${target.container}:${remotePath}`,
    `docker exec ${target.container} dsh plugin --profile ${target.profile} add ${remotePath}`,
  ].join(' && '),
)

// 重启前记下时刻：只看这次的日志，别把上一次启动的告警算进来。
const startedAt = remote('date -u +%Y-%m-%dT%H:%M:%SZ').trim()
remote(`docker restart ${target.container} >/dev/null`)

console.log('→ 等它起来')
let url = ''
let warnings = ''
for (let attempt = 0; attempt < 30; attempt += 1) {
  const logs = remote(`docker logs --since ${startedAt} ${target.container} 2>&1`, { quiet: true })
  const match = logs.match(/https?:\/\/[^\s]*token=[A-Za-z0-9_-]+/)
  const pending = logs.match(/did not activate/g) ?? []
  warnings = pending.length > 0 ? `${pending.length} 个插件没激活，看 docker logs` : ''
  if (match !== undefined && match !== null && match[0] !== '') {
    url = match[0]
    break
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)
}

// 容器里给的是内网地址；要让本机点得开，传 --url http://127.0.0.1:3211/
const token = (url.match(/token=([A-Za-z0-9_-]+)/) ?? [])[1]
const shown = opts.url !== undefined && token !== undefined ? `${opts.url}?token=${token}` : url

console.log('')
console.log(shown === '' ? '⚠ 没等到启动地址，去 docker logs 看' : `✅ 已发布：${shown}`)
if (warnings !== '') console.log(`⚠ ${warnings}`)
console.log(`   版本包：${tarballName}`)
