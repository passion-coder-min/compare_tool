// 浏览器开发调试模式：在非 Tauri 环境（直接用浏览器打开 vite dev server）时，
// mock 掉 __TAURI_INTERNALS__.invoke，返回固定样例数据，便于纯浏览器中调试 UI。
// 仅用于开发调试，正式构建中不会被激活（Tauri 环境下有真实 internals）。
import type { DiffLine, DiffResult, MultiTextDiff } from './types';

interface InvokeArgs {
  leftPath?: string;
  rightPath?: string;
  left?: string;
  right?: string;
  path?: string;
  leftDir?: string;
  rightDir?: string;
  repo?: string;
  baseRef?: string;
  targetRef?: string;
  gitRef?: string;
  startRow?: number;
  rowCount?: number;
  texts?: string[];
  dirs?: string[];
  paths?: string[];
}

// ---------- 极简 LCS 行 diff（仅演示用；正式 diff 在 Rust 端） ----------

function splitLines(s: string): string[] {
  if (s === '') return [];
  const lines = s.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function mockDiff(oldS: string, newS: string): DiffResult {
  const a = splitLines(oldS);
  const b = splitLines(newS);
  const n = a.length;
  const m = b.length;
  // LCS 表（演示数据量小，O(n*m) 足够）
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const rows: DiffResult['rows'] = [];
  const stats = { removed: 0, added: 0, blocks: 0 };
  let i = 0;
  let j = 0;
  let pending = false;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({
        left: { text: a[i], kind: 'equal', number: i + 1, inline: [] },
        right: { text: b[j], kind: 'equal', number: j + 1, inline: [] },
      });
      i++;
      j++;
      pending = false;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({
        left: { text: a[i], kind: 'delete', number: i + 1, inline: [] },
        right: null,
      });
      i++;
      stats.removed++;
      if (!pending) {
        stats.blocks++;
        pending = true;
      }
    } else {
      rows.push({
        left: null,
        right: { text: b[j], kind: 'insert', number: j + 1, inline: [] },
      });
      j++;
      stats.added++;
      if (!pending) {
        stats.blocks++;
        pending = true;
      }
    }
  }
  while (i < n) {
    rows.push({ left: { text: a[i], kind: 'delete', number: i + 1, inline: [] }, right: null });
    i++;
    stats.removed++;
  }
  while (j < m) {
    rows.push({ left: null, right: { text: b[j], kind: 'insert', number: j + 1, inline: [] } });
    j++;
    stats.added++;
  }
  // 简化的行内高亮：整行
  for (const r of rows) {
    if (r.left?.kind === 'delete') r.left.inline = [{ start: 0, end: [...r.left.text].length }];
    if (r.right?.kind === 'insert') r.right.inline = [{ start: 0, end: [...r.right.text].length }];
  }
  return { rows, stats, eol: '\n' };
}

// ---------- 多路 diff（演示用，与 Rust 端算法同构：基准侧对齐） ----------

function mockDiffMulti(texts: string[]): MultiTextDiff {
  const n = texts.length;
  const base = splitLines(texts[0]);
  // 每个非基准侧：base 行号 -> 行文本 | null（无）；间隙 -> 插入行
  const sideMaps = texts.slice(1).map((t) => {
    const d = mockDiff(texts[0], t);
    const byBase = new Map<number, string | null>();
    const gaps = new Map<number, string[]>();
    let cur = 0;
    for (const row of d.rows) {
      if (row.left && row.left.number != null) {
        cur = row.left.number;
        byBase.set(cur, row.right ? row.right.text : null);
      } else if (row.right) {
        if (!gaps.has(cur)) gaps.set(cur, []);
        gaps.get(cur)!.push(row.right.text);
      }
    }
    return { byBase, gaps };
  });
  const mkLine = (text: string, kind: 'equal' | 'insert' | 'delete', number: number | null): DiffLine => ({
    text,
    kind,
    number,
    inline: kind === 'equal' ? [] : [{ start: 0, end: [...text].length }],
  });
  const rows: (DiffLine | null)[][] = [];
  let blocks = 0;
  let changed = 0;
  let inBlock = false;
  const push = (slots: (DiffLine | null)[]) => {
    const eq = slots.every((s) => s !== null && s.kind === 'equal');
    if (eq) {
      inBlock = false;
    } else {
      changed++;
      if (!inBlock) {
        blocks++;
        inBlock = true;
      }
    }
    rows.push(slots);
  };
  for (let i = 0; i < base.length; i++) {
    const gap = i; // 基准行 i+1 之前的间隙（在 i 行之后）
    const maxIns = Math.max(0, ...sideMaps.map((m) => m.gaps.get(gap)?.length ?? 0));
    for (let j = 0; j < maxIns; j++) {
      push([null, ...sideMaps.map((m) => {
        const t = m.gaps.get(gap)?.[j];
        return t === undefined ? null : mkLine(t, 'insert', null);
      })]);
    }
    const allEq = sideMaps.every((m) => m.byBase.get(i + 1) != null);
    push([
      mkLine(base[i], allEq ? 'equal' : 'delete', i + 1),
      ...sideMaps.map((m) => {
        const t = m.byBase.get(i + 1);
        return t == null ? null : mkLine(t, allEq ? 'equal' : 'insert', null);
      }),
    ]);
  }
  const endGap = base.length;
  const maxIns = Math.max(0, ...sideMaps.map((m) => m.gaps.get(endGap)?.length ?? 0));
  for (let j = 0; j < maxIns; j++) {
    push([null, ...sideMaps.map((m) => {
      const t = m.gaps.get(endGap)?.[j];
      return t === undefined ? null : mkLine(t, 'insert', null);
    })]);
  }
  return { rows, sides: n, eols: texts.map(() => '\n'), stats: { blocks, changed } };
}

// ---------- 样例数据 ----------

const DEMO_LEFT = `#!/usr/bin/env python3
"""示例文件：用于浏览器调试 diff 视图。"""
import os
import sys


def main():
    config = load_config("/etc/app.conf")
    if not config:
        print("配置为空")
        return 1
${pad('同内容行', 14)}
    for section in config.sections():
        print(section, config.get(section, "enabled"))

    logger = setup_logger(config.get("log", "level"))
    logger.info("启动完成")
    return 0


if __name__ == "__main__":
    sys.exit(main())
`;

const DEMO_RIGHT = `#!/usr/bin/env python3
"""示例文件：用于浏览器调试 diff 视图。"""
import json
import os
import sys


def main():
    config = load_config("/etc/app.json")
    if not config:
        print("配置为空", file=sys.stderr)
        return 2
${pad('同内容行', 14)}
    for section in config.sections():
        print(section, config.get(section, "enabled"))

    logger = setup_logger(config.get("log", "level"), rotate=True)
    logger.info("启动完成", extra={"pid": os.getpid()})
    metrics.start()
    return 0


if __name__ == "__main__":
    sys.exit(main())
`;

function pad(s: string, n: number): string {
  return Array.from({ length: n }, () => `    # ${s}`).join('\n');
}

const DEMO_DIR = [
  { rel_path: 'README.md', is_dir: false, status: 'different', left_size: 1024, right_size: 1280, left_mtime: 1e12, right_mtime: 1.1e12, error: null },
  { rel_path: 'src', is_dir: true, status: 'same', left_size: 0, right_size: 0, left_mtime: 1e12, right_mtime: 1e12, error: null },
  { rel_path: 'src/main.rs', is_dir: false, status: 'left_newer', left_size: 20480, right_size: 20480, left_mtime: 1.5e12, right_mtime: 1.2e12, error: null },
  { rel_path: 'src/lib.rs', is_dir: false, status: 'same', left_size: 8192, right_size: 8192, left_mtime: 1e12, right_mtime: 1e12, error: null },
  { rel_path: 'docs/new.md', is_dir: false, status: 'only_right', left_size: null, right_size: 256, left_mtime: null, right_mtime: 1.3e12, error: null },
  { rel_path: 'legacy/', is_dir: false, status: 'only_left', left_size: 512, right_size: null, left_mtime: 0.9e12, right_mtime: null, error: null },
];

const DEMO_DIR3 = [
  { rel_path: 'shared/equal.txt', is_dir: false, sides: [
    { present: true, size: 100, mtime_ms: 1e12 },
    { present: true, size: 100, mtime_ms: 1e12 },
    { present: true, size: 100, mtime_ms: 1e12 },
  ], class: [0, 0, 0], all_equal: true, error: null },
  { rel_path: 'src/main.rs', is_dir: false, sides: [
    { present: true, size: 20480, mtime_ms: 1.5e12 },
    { present: true, size: 20480, mtime_ms: 1.5e12 },
    { present: true, size: 24576, mtime_ms: 1.6e12 },
  ], class: [0, 0, 1], all_equal: false, error: null },
  { rel_path: 'config.yaml', is_dir: false, sides: [
    { present: true, size: 512, mtime_ms: 1e12 },
    { present: true, size: 600, mtime_ms: 1.1e12 },
    { present: true, size: 512, mtime_ms: 1e12 },
  ], class: [0, 1, 0], all_equal: false, error: null },
  { rel_path: 'docs/only-right.md', is_dir: false, sides: [
    { present: false, size: null, mtime_ms: null },
    { present: true, size: 256, mtime_ms: 1.3e12 },
    { present: false, size: null, mtime_ms: null },
  ], class: [4294967295, 0, 4294967295], all_equal: false, error: null },
  { rel_path: 'legacy/', is_dir: false, sides: [
    { present: true, size: 512, mtime_ms: 0.9e12 },
    { present: false, size: null, mtime_ms: null },
    { present: false, size: null, mtime_ms: null },
  ], class: [0, 4294967295, 4294967295], all_equal: false, error: null },
];

const DEMO_GIT_DIR = [
  { rel_path: 'src/main.rs', status: 'M', old_path: null, left_size: 20480, right_size: 24576 },
  { rel_path: 'docs/architecture.md', status: 'A', old_path: null, left_size: null, right_size: 4096 },
  { rel_path: 'legacy/config.py', status: 'D', old_path: null, left_size: 1024, right_size: null },
  { rel_path: 'src/utils.rs', status: 'R', old_path: 'src/helpers.rs', left_size: 8192, right_size: 8192 },
];

const DEMO_GRAPH = {
  commits: [
    { sha: 'f000000000000000000000000000000000000004', short: 'f00004', author: '张三', timestamp: 1755600000, message: 'feat: 支持分支树对比视图', parents: ['f000000000000000000000000000000000000003'], lane: 1 },
    { sha: 'f000000000000000000000000000000000000003', short: 'f00003', author: '张三', timestamp: 1755500000, message: 'fix: 修复 mtime 同步', parents: ['f000000000000000000000000000000000000002'], lane: 1 },
    { sha: 'f000000000000000000000000000000000000002', short: 'f00002', author: '李四', timestamp: 1755400000, message: 'feat: 新增 hex 视图', parents: ['f000000000000000000000000000000000000001'], lane: 1 },
    { sha: 'e000000000000000000000000000000000000002', short: 'e00002', author: '王五', timestamp: 1755300000, message: 'chore: 升级依赖', parents: ['e000000000000000000000000000000000000001'], lane: 0 },
    { sha: 'f000000000000000000000000000000000000001', short: 'f00001', author: '张三', timestamp: 1755200000, message: 'feat: cherry-pick 流程', parents: ['e000000000000000000000000000000000000001'], lane: 1 },
  ],
  merge_base: 'e000000000000000000000000000000000000001',
  already_in_current: ['f000000000000000000000000000000000000002'],
  current_branch: 'main',
};

// ---------- 安装 mock ----------

export function installTauriMock() {
  const w = window as unknown as Record<string, unknown>;
  if (w.__TAURI_INTERNALS__) return;
  w.__TAURI_INTERNALS__ = {
    invoke(cmd: string, args: InvokeArgs = {}) {
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          switch (cmd) {
            case 'compare_text_content':
              resolve(mockDiff(args.left ?? '', args.right ?? ''));
              break;
            case 'compare_text_multi':
              resolve(mockDiffMulti(args.texts as string[] ?? [args.left ?? '', args.right ?? '']));
              break;
            case 'compare_dirs_multi':
              resolve((args.dirs as string[]).length >= 3 ? DEMO_DIR3 : DEMO_DIR.map((e) => ({
                rel_path: e.rel_path,
                is_dir: e.is_dir,
                sides: [
                  { present: e.left_size !== null, size: e.left_size, mtime_ms: e.left_mtime },
                  { present: e.right_size !== null, size: e.right_size, mtime_ms: e.right_mtime },
                ],
                class: [e.status === 'only_right' ? 4294967295 : 0, e.status === 'only_left' ? 4294967295 : (e.status === 'different' || e.status === 'left_newer' || e.status === 'right_newer' ? 1 : 0)],
                all_equal: e.status === 'same',
                error: null,
              })));
              break;
            case 'hex_overview_multi': {
              const paths = (args.paths as string[]) ?? [];
              resolve({ sizes: paths.map((_, i) => 4096 + i * 16), first_diff: 271, identical: false });
              break;
            }
            case 'read_hex_window_multi': {
              const paths = (args.paths as string[]) ?? [];
              const n = Math.max(2, paths.length);
              const start = (args.startRow as number) ?? 0;
              const count = (args.rowCount as number) ?? 256;
              resolve(
                Array.from({ length: count }, (_, k) => {
                  const offset = (start + k) * 16;
                  const sides = Array.from({ length: n }, (_, side) =>
                    Array.from({ length: 16 }, (_, i) => (offset + i + side) % 251),
                  );
                  const diff: number[] = [];
                  for (let i = 0; i < 16; i++) {
                    if (new Set(sides.map((s) => s[i])).size > 1) diff.push(i);
                  }
                  return { offset, sides, diff };
                }),
              );
              break;
            }
            case 'path_kind': {
              const p = args.path ?? '';
              resolve(/\.[A-Za-z0-9]+$/.test(p) ? 'file' : 'dir');
              break;
            }
            case 'compare_text':
              resolve(mockDiff(DEMO_LEFT, DEMO_RIGHT));
              break;
            case 'read_text_file': {
              const p = args.path ?? '';
              if (p.includes('/b') || p.includes('right') || p.includes('target'))
                resolve({ content: DEMO_RIGHT, eol: '\n' });
              else if (p.includes('/c'))
                resolve({ content: DEMO_RIGHT.replace('metrics.start();\n', 'metrics.start();\n    telemetry.init(config)\n'), eol: '\n' });
              else resolve({ content: DEMO_LEFT, eol: '\n' });
              break;
            }
            case 'save_file':
              resolve(null);
              break;
            case 'compare_dirs':
              resolve(DEMO_DIR);
              break;
            case 'git_dir_diff':
              resolve(DEMO_GIT_DIR);
              break;
            case 'git_graph':
              resolve(DEMO_GRAPH);
              break;
            case 'git_open_repo':
              resolve({ root: args.path ?? '/demo/repo', current_branch: 'main', branches: ['main', 'feature/tree-view'] });
              break;
            case 'git_file_content':
              resolve(args.gitRef?.includes('main') || args.gitRef === ':2' ? DEMO_LEFT : DEMO_RIGHT);
              break;
            case 'hex_overview':
              resolve({ left_size: 4096, right_size: 4112, first_diff: 271, identical: false });
              break;
            case 'read_hex_window': {
              const start = (args.startRow as number) ?? 0;
              const count = (args.rowCount as number) ?? 256;
              resolve(
                Array.from({ length: count }, (_, k) => {
                  const offset = (start + k) * 16;
                  const left = Array.from({ length: 16 }, (_, i) => (offset + i) % 251);
                  const right = left.map((v, i) => (Math.floor(offset / 16) % 7 === 3 && i % 3 === 0 ? (v + 1) % 256 : v));
                  return {
                    offset,
                    left,
                    right,
                    left_diff: left.map((v, i) => (v !== right[i] ? i : -1)).filter((x) => x >= 0),
                    right_diff: left.map((v, i) => (v !== right[i] ? i : -1)).filter((x) => x >= 0),
                  };
                }),
              );
              break;
            }
            default:
              reject(new Error(`mock 未实现: ${cmd}`));
          }
        }, 120);
      });
    },
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    platform: 'linux',
    event: { listen: async () => () => {}, emit: async () => {} },
    channel: { create: () => ({ id: 0 }) },
  };
}

/** 浏览器演示模式：按 URL 参数预置对比源 */
export function presetDemoSources() {
  const demo = new URLSearchParams(location.search).get('demo');
  if (!demo) return;
  import('./../stores/compare').then(({ useCompare }) => {
    if (demo === 'dir') {
      useCompare.getState().setSource(0, { kind: 'dir', path: '/demo/left' });
      useCompare.getState().setSource(1, { kind: 'dir', path: '/demo/right' });
    } else if (demo === 'dir3') {
      useCompare.getState().setSource(0, { kind: 'dir', path: '/demo/a' });
      useCompare.getState().setSource(1, { kind: 'dir', path: '/demo/b' });
      useCompare.getState().addSource();
      useCompare.getState().setSource(2, { kind: 'dir', path: '/demo/c' });
    } else if (demo === 'file') {
      useCompare.getState().setSource(0, { kind: 'file', path: '/demo/a.py' });
      useCompare.getState().setSource(1, { kind: 'file', path: '/demo/b.py' });
    } else if (demo === 'git') {
      useCompare.getState().setSource(0, { kind: 'git', repo: '/demo/repo', ref: 'main' });
      useCompare.getState().setSource(1, { kind: 'git', repo: '/demo/repo', ref: 'feature/tree-view' });
    }
  });
}
