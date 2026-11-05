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
 *   node scripts/deploy.mjs --ssh ... --container ... --persona personas/default
 *       顺带把人格包同步过去（只同步 .md 与人设样例，不碰记忆与 identity.json）
 *
 * 目标也可以走环境变量：DEPLOY_SSH / DEPLOY_CONTAINER / DEPLOY_PROFILE。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
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
  persona: opts.persona,
  personaId: opts['persona-id'] ?? process.env.DEPLOY_PERSONA_ID ?? 'default',
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

// 所有带 cordis.patch.yml 的包都是插件，得一起装 —— 只装 channel 会让驱动停在上一版。
const packagesDir = join(process.cwd(), 'packages')
const plugins = readdirSync(packagesDir)
  .filter((name) => existsSync(join(packagesDir, name, 'cordis.patch.yml')))
  .map((name) => {
    const dir = join(packagesDir, name)
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const file = `${pkg.name}-${pkg.version}.tgz`
    return { name: pkg.name, dir, local: join(dir, file), remote: `/tmp/shixu-${name}-${hash}.tgz` }
  })
if (plugins.length === 0) throw new Error('packages/ 下没有找到插件包')

console.log(`→ 打包（${plugins.map((item) => item.name).join(' + ')}）`)
for (const item of plugins) {
  local('pnpm', ['pack'], { cwd: item.dir, quiet: true, shell: process.platform === 'win32' })
  if (!existsSync(item.local)) throw new Error(`没找到打包产物：${item.local}`)
}

console.log('→ 传上去')
for (const item of plugins) {
  // 用 ssh + cat 而不是 scp：别名里带斜杠时 scp 会把它当成两个本地路径。
  const uploaded = spawnSync('ssh', ['-o', 'BatchMode=yes', target.ssh, `cat > ${item.remote}`], {
    input: readFileSync(item.local),
  })
  if (uploaded.status !== 0) throw new Error(`上传失败（${item.name}）：${uploaded.stderr ?? ''}`)
}

if (target.persona !== undefined) {
  console.log('→ 同步人格包')
  const dir = join(process.cwd(), target.persona)
  if (!existsSync(dir)) throw new Error(`没找到人格包：${dir}`)
  // 只同步人设文本与样例：identity.json 和 memory/ 是实例上的东西，不能被盖掉。
  const files = readdirSync(dir).filter((name) => name.endsWith('.md') || name.endsWith('.example.json'))
  const destination = `/data/dsh-home/persona/${target.personaId}`
  remote(`docker exec ${target.container} mkdir -p ${destination}`)
  for (const name of files) {
    const written = spawnSync(
      'ssh',
      ['-o', 'BatchMode=yes', target.ssh, `docker exec -i ${target.container} sh -c 'cat > ${destination}/${name}'`],
      { input: readFileSync(join(dir, name)) },
    )
    if (written.status !== 0) throw new Error(`人格文件同步失败（${name}）：${written.stderr ?? ''}`)
  }
  console.log(`   ${files.length} 个文件 → ${destination}`)
  // 人设是每次投递时读的，不需要重启。只想同步人设就别跟着装包重启。
  if (opts['persona-only'] === true) process.exit(0)
  if (opts['persona-only'] === 'true') process.exit(0)
}

console.log('→ 装进容器')
remote(
  plugins
    .map((item) =>
      [
        `docker cp ${item.remote} ${target.container}:${item.remote}`,
        `docker exec ${target.container} dsh plugin --profile ${target.profile} add ${item.remote}`,
      ].join(' && '),
    )
    .join(' && '),
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
console.log(`   版本包：${plugins.map((item) => item.name).join(' / ')} @ ${hash}`)
