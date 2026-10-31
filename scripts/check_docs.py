#!/usr/bin/env python3
"""文档自检。用法：python scripts/check_docs.py [仓库根]

默认根目录是脚本所在目录的上一级。退出码 0 = 全部通过；1 = 有问题（逐条输出）。

覆盖：H1 唯一 / 标题不跳级 / 标题 <=4 级 / 围栏带语言 / 无盘符路径 / 无连续 --- /
      超 300 行有目录 / 相对链接有效 / 禁词 / 孤儿文档（未被任何文档链接）。
"""
import io
import os
import re
import sys

MAX_HEADING = 4
TOC_LINE_LIMIT = 300
# 文档里不该出现的「历史垃圾」词。按项目调整。
BANNED = ["勘误", "变更记录", "变更日志", "TODO", "以前是", "已废弃"]
# 规则文件本身会讲到这些词，豁免
EXEMPT_BANNED = {"AGENTS.md"}


def repo_root(argv):
    if len(argv) > 1:
        return os.path.abspath(argv[1])
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(here)


def md_files(root):
    out = []
    for name in ("README.md", "AGENTS.md"):
        if os.path.exists(os.path.join(root, name)):
            out.append(name)
    docs = os.path.join(root, "docs")
    for base, _dirs, files in os.walk(docs):
        for f in files:
            if f.endswith(".md"):
                rel = os.path.relpath(os.path.join(base, f), root)
                out.append(rel.replace(os.sep, "/"))
    return sorted(set(out))


def scan(root, path, bad):
    lines = io.open(os.path.join(root, path), encoding="utf-8").read().split("\n")
    infence = False
    levels = []
    nolang = abs_path = dup_sep = banned = 0
    for i, line in enumerate(lines):
        if line.startswith("```"):
            if not infence and line.strip() == "```":
                nolang += 1
            infence = not infence
            continue
        if infence:
            continue
        m = re.match(r"^(#{1,6}) ", line)
        if m:
            levels.append(len(m.group(1)))
        if re.search(r"(?<![A-Za-z0-9])[A-Za-z]:[\\/]", line):
            abs_path += 1
        if i and line.strip() == "---" and lines[i - 1].strip() == "---":
            dup_sep += 1
        # 禁词只查标题行：正文里引用规则时会提到这些词，属于自指误报
        if line.startswith("#") and path not in EXEMPT_BANNED:
            for word in BANNED:
                if word in line:
                    banned += 1
                    break

    jumps = sum(1 for k in range(1, len(levels)) if levels[k] - levels[k - 1] > 1)
    h1 = sum(1 for x in levels if x == 1)
    if h1 != 1:
        bad.append("%s: H1 数量 = %d（应为 1）" % (path, h1))
    if jumps:
        bad.append("%s: 标题跳级 %d 处" % (path, jumps))
    if levels and max(levels) > MAX_HEADING:
        bad.append("%s: 标题超过 %d 级" % (path, MAX_HEADING))
    if nolang:
        bad.append("%s: 无语言代码围栏 %d 处" % (path, nolang))
    if abs_path:
        bad.append("%s: 绝对路径 %d 处" % (path, abs_path))
    if dup_sep:
        bad.append("%s: 连续 --- %d 处" % (path, dup_sep))
    if banned:
        bad.append("%s: 禁词（勘误/变更记录/TODO/以前是 等）%d 处" % (path, banned))
    has_toc = any(re.match(r"^#{2,3} .*目\s*录", x) for x in lines[:80])
    if len(lines) > TOC_LINE_LIMIT and not has_toc:
        bad.append("%s: 超过 %d 行但没有目录" % (path, TOC_LINE_LIMIT))

    # 元信息块：docs/ 下每份文档开头必须有状态与日期
    head = lines[:12]
    if path.startswith("docs/") and not (
        any(x.startswith("> **状态**") for x in head)
        and any(x.startswith("> **日期**") for x in head)
    ):
        bad.append("%s: 缺元信息块（状态 / 日期 / 读者 / 上游材料）" % path)


def links(root, path):
    """返回 (path, 目标) 对；目标为规范化后的仓库相对路径。"""
    text = io.open(os.path.join(root, path), encoding="utf-8").read()
    base = os.path.dirname(os.path.join(root, path))
    for m in re.finditer(r"\]\(([^)\s]+\.md)(#[^)]*)?\)", text):
        target = m.group(1)
        if target.startswith("http"):
            continue
        yield path, os.path.normpath(os.path.join(base, target)), target


def main(argv):
    root = repo_root(argv)
    files = md_files(root)
    if not files:
        print("没找到 markdown 文件，检查仓库根是否正确：%s" % root)
        return 1
    bad = []
    for path in files:
        scan(root, path, bad)

    linked = set()
    for path in files:
        for src, full, raw in links(root, path):
            if not os.path.exists(full):
                bad.append("%s: 断链 -> %s" % (src, raw))
                continue
            linked.add(os.path.relpath(full, root).replace(os.sep, "/"))

    # 孤儿检查：除索引与被索引的入口外，每份文档都应被至少一处链接
    index = "docs/README.md"
    for path in files:
        if path in (index, "README.md") or path in linked:
            continue
        bad.append("%s: 孤儿文档（没有任何文档链接它；请在 docs/README.md 登记）" % path)

    if bad:
        print("\n".join(bad))
        print("")
        print("FAIL：%d 处问题（检查了 %d 份文档）" % (len(bad), len(files)))
        return 1
    print("OK：文档自检全部通过（%d 份）" % len(files))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
