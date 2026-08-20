// 统一目录对比视图（Beyond Compare 风格树形布局）：
// 默认仅显示顶层条目，目录可展开/折叠；文件夹状态为子树聚合（含差异计数徽标）；
// 两路目录模式在左右名称列之间的中缝提供单行 ◀/▶ 复制按钮（文件夹为递归复制）；
// git 分支（两路）与多路（3-4 路）模式同样按树组织（只读）。双击文件切到文本对比。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { confirm } from '@tauri-apps/plugin-dialog';
import { useVirtualizer } from '@tanstack/react-virtual';
import { api } from '../../lib/tauri';
import type { DirStatus } from '../../lib/types';
import { formatSize, formatTime, joinPath } from '../../lib/utils';
import { toast } from '../../stores/toast';
import type { SourceSpec } from '../../stores/compare';

const STRIPE =
  'bg-[repeating-linear-gradient(45deg,transparent,transparent_6px,#f5f5f5_6px,#f5f5f5_12px)]';
const ABSENT = 4294967295;

export interface UnifiedEntry {
  relPath: string;
  isDir: boolean;
  fsStatus?: DirStatus;
  gitStatus?: string;
  oldPath?: string | null;
  multi?: { present: boolean; size: number | null; mtime: number | null; cls: number }[];
  allEqual?: boolean;
  leftMtime: number | null;
  rightMtime: number | null;
  error?: string | null;
}

type Kind = 'different' | 'missing' | 'newer' | 'same';

interface TreeNode {
  name: string;
  relPath: string;
  isDir: boolean;
  /** 文件条目 */
  entry?: UnifiedEntry;
  /** 目录自身条目（后端目录行，可能缺省） */
  dirEntry?: UnifiedEntry;
  children: TreeNode[];
  /** 子树聚合 */
  different: number;
  missing: number;
  newer: number;
  files: number;
  /** 各侧是否存在（由条目与后代推导） */
  present: boolean[];
}

function classify(e: UnifiedEntry): Kind {
  if (e.gitStatus) {
    if (e.gitStatus === 'A' || e.gitStatus === 'D') return 'missing';
    if (e.gitStatus === 'R' || e.gitStatus === 'C') return 'different';
    return 'different';
  }
  if (e.fsStatus) {
    if (e.fsStatus === 'only_left' || e.fsStatus === 'only_right') return 'missing';
    if (e.fsStatus === 'left_newer' || e.fsStatus === 'right_newer') return 'newer';
    if (e.fsStatus === 'different') return 'different';
    return 'same';
  }
  const present = (e.multi ?? []).filter((s) => s.present).length;
  if (present < (e.multi ?? []).length) return 'missing';
  return e.allEqual ? 'same' : 'different';
}

function newNode(name: string, relPath: string, isDir: boolean, sides: number): TreeNode {
  return { name, relPath, isDir, children: [], different: 0, missing: 0, newer: 0, files: 0, present: Array.from({ length: sides }, () => false) };
}

/** 由平铺条目构建树（目录优先插入，再挂文件；后序聚合状态） */
function buildTree(entries: UnifiedEntry[], sides: number): TreeNode[] {
  const root = newNode('', '', true, sides);
  const dirMap = new Map<string, TreeNode>();

  const ensureDir = (relPath: string): TreeNode => {
    const hit = dirMap.get(relPath);
    if (hit) return hit;
    const segs = relPath.split('/');
    const name = segs[segs.length - 1];
    const parent = segs.length === 1 ? root : ensureDir(segs.slice(0, -1).join('/'));
    const node = newNode(name, relPath, true, sides);
    parent.children.push(node);
    dirMap.set(relPath, node);
    return node;
  };

  // 先目录后文件，保证父节点先建好
  for (const e of [...entries].sort((a, b) => Number(a.isDir) - Number(b.isDir))) {
    const segs = e.relPath.split('/');
    if (e.isDir) {
      const node = ensureDir(e.relPath);
      node.dirEntry = e;
    } else {
      const parent = segs.length === 1 ? root : ensureDir(segs.slice(0, -1).join('/'));
      const node = newNode(segs[segs.length - 1], e.relPath, false, sides);
      node.entry = e;
      parent.children.push(node);
    }
  }

  // 后序：聚合 + 推导目录存在性
  const walk = (node: TreeNode) => {
    for (const c of node.children) walk(c);
    if (!node.isDir) {
      const k = classify(node.entry!);
      if (k === 'different') node.different++;
      else if (k === 'missing') node.missing++;
      else if (k === 'newer') node.newer++;
      node.files++;
      (node.entry!.multi ?? []).forEach((s, i) => {
        if (s.present) node.present[i] = true;
      });
      return;
    }
    let d = 0;
    let m = 0;
    let nw = 0;
    let f = 0;
    for (const c of node.children) {
      d += c.different;
      m += c.missing;
      nw += c.newer;
      f += c.files;
      c.present.forEach((p, i) => {
        if (p) node.present[i] = true;
      });
    }
    node.different = d;
    node.missing = m;
    node.newer = nw;
    node.files = f;
    // 后端目录行提供的存在性兜底
    (node.dirEntry?.multi ?? []).forEach((s, i) => {
      if (s.present) node.present[i] = true;
    });
  };
  walk(root);

  // 排序：目录在前，名称字母序
  const sortRec = (n: TreeNode) => {
    n.children.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
    });
    n.children.forEach(sortRec);
  };
  sortRec(root);
  return root.children;
}

function nodeStatusIcon(node: TreeNode): { icon: string; cls: string; label: string } {
  if (!node.isDir) return fileStatusIcon(node.entry!);
  if (node.different > 0)
    return { icon: '≠', cls: 'text-red-700 bg-red-200 font-bold', label: `${node.different} 处不同` };
  if (node.missing > 0)
    return { icon: '◇', cls: 'text-blue-700 bg-blue-100', label: `${node.missing} 个仅单侧存在` };
  if (node.newer > 0)
    return { icon: '↻', cls: 'text-amber-700 bg-amber-100', label: `${node.newer} 个较新` };
  return { icon: '=', cls: 'text-neutral-400 bg-neutral-100', label: '子树内容相同' };
}

function fileStatusIcon(e: UnifiedEntry): { icon: string; cls: string; label: string } {
  if (e.gitStatus) {
    const m: Record<string, { icon: string; cls: string; label: string }> = {
      M: { icon: '≠', cls: 'text-red-700 bg-red-200 font-bold', label: '两侧均有但内容不同' },
      A: { icon: '>', cls: 'text-emerald-700 bg-emerald-100', label: '仅右侧（新增）' },
      D: { icon: '<', cls: 'text-red-700 bg-red-100', label: '仅左侧（删除）' },
      R: { icon: '→', cls: 'text-blue-700 bg-blue-100', label: '重命名' },
      C: { icon: '≫', cls: 'text-blue-700 bg-blue-100', label: '复制' },
      T: { icon: '≀', cls: 'text-purple-700 bg-purple-100', label: '类型变更' },
    };
    return m[e.gitStatus] ?? m.M;
  }
  if (e.fsStatus) {
    const m: Record<DirStatus, { icon: string; cls: string; label: string }> = {
      only_left: { icon: '<', cls: 'text-blue-700 bg-blue-100', label: '仅左侧' },
      only_right: { icon: '>', cls: 'text-blue-700 bg-blue-100', label: '仅右侧' },
      same: { icon: '=', cls: 'text-neutral-400 bg-neutral-100', label: '相同' },
      different: { icon: '≠', cls: 'text-red-700 bg-red-200 font-bold', label: '不同' },
      left_newer: { icon: '→', cls: 'text-amber-700 bg-amber-100', label: '左侧较新' },
      right_newer: { icon: '←', cls: 'text-amber-700 bg-amber-100', label: '右侧较新' },
      error: { icon: '!', cls: 'text-red-700 bg-red-100', label: '错误' },
    };
    return m[e.fsStatus];
  }
  const present = (e.multi ?? []).filter((s) => s.present).length;
  if (present < (e.multi ?? []).length)
    return { icon: '◇', cls: 'text-blue-700 bg-blue-100', label: `仅 ${present} 侧存在` };
  if (e.allEqual) return { icon: '=', cls: 'text-neutral-400 bg-neutral-100', label: '各侧相同' };
  return { icon: '≠', cls: 'text-red-700 bg-red-200 font-bold', label: '各侧存在差异' };
}

/** 名称单元格着色 */
function cellTint(node: TreeNode, side: number): string {
  if (!node.present[side]) return '';
  if (node.isDir) {
    if (node.different > 0) return 'bg-red-50';
    if (node.missing > 0) return 'bg-blue-50';
    return '';
  }
  const e = node.entry!;
  if (e.gitStatus) {
    if (e.gitStatus === 'A') return side === (e.multi ?? []).length - 1 ? 'bg-emerald-100' : '';
    if (e.gitStatus === 'D') return side === 0 ? 'bg-red-100' : '';
    return 'bg-red-100';
  }
  if (e.fsStatus) {
    if (e.fsStatus === 'left_newer') return side === 0 ? 'bg-amber-100' : '';
    if (e.fsStatus === 'right_newer') return side === 1 ? 'bg-amber-100' : '';
    if (e.fsStatus === 'same') return '';
    if (e.fsStatus === 'different') return 'bg-red-100';
    return 'bg-blue-100';
  }
  // 多路：全侧存在且一致为无色，否则微红提示差异（类字母徽标在名称列显示）
  return node.present.every(Boolean) && (e.allEqual || false) ? '' : 'bg-red-100';
}

const classLetter = (c: number) => String.fromCharCode('a'.charCodeAt(0) + c);

const ROW_H = 30;

export function DirCompareView({
  sources,
  onOpenFile,
}: {
  sources: SourceSpec[];
  onOpenFile: (e: UnifiedEntry) => void;
}) {
  const n = sources.length;
  const gitMode =
    n === 2 && sources[0].kind === 'git' && sources[1].kind === 'git' && (sources[0] as { repo: string }).repo === (sources[1] as { repo: string }).repo;

  const [entries, setEntries] = useState<UnifiedEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [useHash, setUseHash] = useState(false);
  const [busy, setBusy] = useState(0);
  const [onlyDiff, setOnlyDiff] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const fsDirs =
    !gitMode && sources.every((s) => s.kind === 'dir')
      ? sources.map((s) => (s as { path: string }).path)
      : null;
  const twoWayFs = fsDirs !== null && n === 2;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      if (gitMode) {
        const g0 = sources[0] as { repo: string; ref: string };
        const g1 = sources[1] as { repo: string; ref: string };
        const list = await api.gitDirDiff(g0.repo, g0.ref, g1.ref);
        setEntries(
          list.map((e) => ({
            relPath: e.rel_path,
            isDir: false,
            gitStatus: e.status,
            oldPath: e.old_path,
            multi: [
              { present: e.status !== 'A', size: e.left_size, mtime: null, cls: 0 },
              { present: e.status !== 'D', size: e.right_size, mtime: null, cls: 1 },
            ],
            leftMtime: null,
            rightMtime: null,
          })),
        );
      } else if (fsDirs) {
        if (n === 2) {
          const list = await api.compareDirs(fsDirs[0], fsDirs[1], useHash);
          setEntries(
            list.map((e) => ({
              relPath: e.rel_path,
              isDir: e.is_dir,
              fsStatus: e.status,
              multi: [
                { present: e.status !== 'only_right', size: e.left_size, mtime: e.left_mtime, cls: 0 },
                { present: e.status !== 'only_left', size: e.right_size, mtime: e.right_mtime, cls: 1 },
              ],
              leftMtime: e.left_mtime,
              rightMtime: e.right_mtime,
              error: e.error,
            })),
          );
        } else {
          const list = await api.compareDirsMulti(fsDirs, useHash);
          setEntries(
            list.map((e) => ({
              relPath: e.rel_path,
              isDir: e.is_dir,
              allEqual: e.all_equal,
              multi: e.sides.map((s, i) => ({
                present: s.present,
                size: s.size,
                mtime: s.mtime_ms,
                cls: e.class[i],
              })),
              leftMtime: null,
              rightMtime: null,
              error: e.error,
            })),
          );
        }
      }
      setSelection(new Set());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [gitMode, sources, useHash, fsDirs, n]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // ---------- 树构建与可见行 ----------

  const tree = useMemo(() => buildTree(entries ?? [], n), [entries, n]);

  /** 过滤：只看有差异的子树/文件 */
  const nodeVisible = useCallback(
    (node: TreeNode): boolean => {
      if (!onlyDiff) return true;
      if (node.isDir) return node.different + node.missing + node.newer > 0;
      const k = classify(node.entry!);
      return k !== 'same';
    },
    [onlyDiff],
  );

  const visibleRows = useMemo(() => {
    const rows: { node: TreeNode; depth: number }[] = [];
    const walk = (nodes: TreeNode[], depth: number) => {
      for (const nd of nodes) {
        if (!nodeVisible(nd)) continue;
        rows.push({ node: nd, depth });
        if (nd.isDir && expanded.has(nd.relPath)) walk(nd.children, depth + 1);
      }
    };
    walk(tree, 0);
    return rows;
  }, [tree, expanded, nodeVisible]);

  const toggleExpand = (relPath: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(relPath)) next.delete(relPath);
      else next.add(relPath);
      return next;
    });

  // ---------- 操作 ----------

  const copyOne = async (relPath: string, direction: 'toRight' | 'toLeft') => {
    if (!fsDirs || fsDirs.length !== 2) return;
    const [src, dst] = direction === 'toRight' ? [fsDirs[0], fsDirs[1]] : [fsDirs[1], fsDirs[0]];
    setBusy(1);
    try {
      await api.copyPathAcross(joinPath(src, relPath), joinPath(dst, relPath));
      toast.success(`已复制到${direction === 'toRight' ? '右' : '左'}侧：${relPath}`);
      await refresh();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(0);
    }
  };

  const selectedEntries = useMemo(() => {
    const byPath = new Map((entries ?? []).map((e) => [e.relPath, e]));
    return [...selection].map((p) => byPath.get(p)).filter((e): e is UnifiedEntry => !!e);
  }, [entries, selection]);

  const toggleSel = (rel: string) =>
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });

  const copyTo = async (side: 'left' | 'right') => {
    if (!fsDirs || fsDirs.length !== 2) return;
    const srcRoot = side === 'left' ? fsDirs[1] : fsDirs[0];
    const dstRoot = side === 'left' ? fsDirs[0] : fsDirs[1];
    const candidates = selectedEntries.filter(
      (e) => e.fsStatus !== (side === 'left' ? 'only_left' : 'only_right'),
    );
    if (candidates.length === 0) return;
    setBusy(candidates.length);
    let ok = 0;
    for (const e of candidates) {
      try {
        await api.copyPathAcross(joinPath(srcRoot, e.relPath), joinPath(dstRoot, e.relPath));
        ok++;
      } catch (err) {
        toast.error(`${e.relPath}: ${err}`);
      }
    }
    setBusy(0);
    toast.success(`已复制 ${ok} 项到${side === 'left' ? '左' : '右'}侧`);
    refresh();
  };

  const deleteSide = async (side: 'left' | 'right') => {
    if (!fsDirs || fsDirs.length !== 2) return;
    const root = side === 'left' ? fsDirs[0] : fsDirs[1];
    const candidates = selectedEntries.filter(
      (e) => e.fsStatus !== (side === 'left' ? 'only_right' : 'only_left'),
    );
    if (candidates.length === 0) return;
    const yes = await confirm(
      `确定删除${side === 'left' ? '左' : '右'}侧选中的 ${candidates.length} 个文件/文件夹吗？\n此操作不可恢复。`,
      { title: '确认删除', kind: 'warning' },
    );
    if (!yes) return;
    setBusy(candidates.length);
    for (const e of candidates) {
      try {
        await api.deletePath(joinPath(root, e.relPath), e.isDir);
      } catch (err) {
        toast.error(`${e.relPath}: ${err}`);
      }
    }
    setBusy(0);
    toast.success('删除完成');
    refresh();
  };

  // ---------- 虚拟滚动 ----------

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 25,
  });

  // 栅格：[勾选(两路FS)] [状态] [名称×N] [中缝(两路FS)] [大小×N] [时间×2(两路FS)]
  const gridTemplate = useMemo(() => {
    let t = '';
    if (twoWayFs) t += '2.5rem ';
    t += '4rem ';
    for (let i = 0; i < n; i++) t += `minmax(0,${i === 0 ? '1.2fr' : '1fr'}) `;
    if (twoWayFs) t += '3rem '; // 中缝复制按钮列
    for (let i = 0; i < n; i++) t += '6rem ';
    if (twoWayFs) t += '10.5rem 10.5rem';
    return t.trim();
  }, [n, twoWayFs]);

  const allSelected = visibleRows.length > 0 && visibleRows.every((r) => selection.has(r.node.relPath));
  const toggleAll = () =>
    setSelection(allSelected ? new Set() : new Set(visibleRows.map((r) => r.node.relPath)));

  const rootAgg = useMemo(() => {
    let d = 0;
    let m = 0;
    let nw = 0;
    for (const nd of tree) {
      d += nd.different;
      m += nd.missing;
      nw += nd.newer;
    }
    return { d, m, nw };
  }, [tree]);

  const openable = (node: TreeNode) => !node.isDir;

  return (
    <div className="h-full flex flex-col">
      {/* 工具栏 */}
      <header className="flex items-center gap-2 px-3 py-1.5 border-b bg-neutral-50 text-sm shrink-0 flex-wrap">
        <span className="text-xs text-neutral-500">
          {gitMode
            ? `🌿 ${(sources[0] as { ref: string }).ref}...${(sources[1] as { ref: string }).ref} 之间 ${entries?.length ?? 0} 个文件改动`
            : `${n} 路 · ${rootAgg.d} 处不同 · ${rootAgg.m} 个仅单侧 · ${rootAgg.nw} 个较新`}
        </span>
        <label className="flex items-center gap-1 text-xs text-neutral-600 cursor-pointer">
          <input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} />
          只看不同
        </label>
        <label className="flex items-center gap-1 text-xs text-neutral-600 cursor-pointer" title="展开/折叠全部目录">
          <button
            className="btn py-0.5 px-1.5 text-xs"
            onClick={() => {
              const all = new Set<string>();
              if (expanded.size > 0) {
                setExpanded(new Set());
              } else {
                const walk = (nodes: TreeNode[]) => {
                  for (const nd of nodes) {
                    if (nd.isDir) {
                      all.add(nd.relPath);
                      walk(nd.children);
                    }
                  }
                };
                walk(tree);
                setExpanded(all);
              }
            }}
          >
            {expanded.size > 0 ? '⇕ 收起全部' : '⇊ 展开全部'}
          </button>
        </label>
        {twoWayFs && (
          <label className="flex items-center gap-1 text-xs text-neutral-600 cursor-pointer">
            <input type="checkbox" checked={useHash} onChange={(e) => setUseHash(e.target.checked)} />
            内容哈希精确比较
          </label>
        )}
        <span className="text-[11px] text-neutral-400">双击文件对比差异；双击目录展开</span>
        <div className="flex-1" />
        {busy > 0 && <span className="text-xs text-blue-500">处理中…（{busy}）</span>}
        {twoWayFs && (
          <>
            <button className="btn" onClick={() => copyTo('left')} disabled={busy > 0 || selectedEntries.length === 0}>
              ◀ 复制到左侧
            </button>
            <button className="btn" onClick={() => copyTo('right')} disabled={busy > 0 || selectedEntries.length === 0}>
              复制到右侧 ▶
            </button>
            <button className="btn text-red-600" onClick={() => deleteSide('left')} disabled={busy > 0 || selectedEntries.length === 0}>
              删除左侧
            </button>
            <button className="btn text-red-600" onClick={() => deleteSide('right')} disabled={busy > 0 || selectedEntries.length === 0}>
              删除右侧
            </button>
          </>
        )}
        {(gitMode || (fsDirs !== null && n >= 3)) && (
          <span className="text-xs text-neutral-400">{gitMode ? '摘取提交请切到「Git 树」页签' : '多路模式只读'}</span>
        )}
      </header>

      {error && (
        <div className="px-3 py-1.5 bg-red-50 text-red-600 text-xs border-b border-red-200 break-all">
          {error}
        </div>
      )}

      {/* 表头 */}
      <div
        className="grid text-xs text-neutral-500 bg-neutral-100 border-b shrink-0 font-medium items-center"
        style={{ gridTemplateColumns: gridTemplate }}
      >
        {twoWayFs && (
          <div className="px-2 py-1.5">
            <input type="checkbox" checked={allSelected} onChange={toggleAll} />
          </div>
        )}
        <div className="px-2 py-1.5 text-center">状态</div>
        {sources.map((_s, i) => (
          <div
            key={`h${i}`}
            className="px-2 py-1.5 border-l border-neutral-200 truncate"
            title={fsDirs ? fsDirs[i] : ''}
          >
            {i === 0 ? '◀ ' : ''}
            {gitMode
              ? `侧${i + 1}（${(sources[i] as { ref: string }).ref}）`
              : n === 2
                ? i === 0
                  ? '左侧'
                  : '右侧'
                : `侧${i + 1}`}
            {i === n - 1 ? ' ▶' : ''}
          </div>
        ))}
        {twoWayFs && <div className="text-center border-l border-neutral-200" title="复制到另一侧">复制</div>}
        {sources.map((_s, i) => (
          <div key={`hs${i}`} className="px-2 py-1.5 text-right border-l border-neutral-200">
            大小{i + 1}
          </div>
        ))}
        {twoWayFs && <div className="px-2 py-1.5 border-l border-neutral-200">左修改时间</div>}
        {twoWayFs && <div className="px-2 py-1.5">右修改时间</div>}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-auto text-sm">
        {loading && !entries && (
          <div className="py-10 text-center text-sm text-neutral-400">扫描中…</div>
        )}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const { node, depth } = visibleRows[vi.index];
            const icon = nodeStatusIcon(node);
            const isExpanded = expanded.has(node.relPath);
            return (
              <div
                key={vi.key}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: ROW_H,
                  transform: `translateY(${vi.start}px)`,
                  gridTemplateColumns: gridTemplate,
                }}
                className="grid items-center text-xs hover:bg-blue-50/50 border-b border-neutral-100"
                onDoubleClick={() =>
                  node.isDir ? toggleExpand(node.relPath) : openable(node) && onOpenFile(node.entry!)
                }
                title={node.entry?.error ?? (node.isDir ? '双击展开/折叠' : '双击打开文件对比')}
              >
                {twoWayFs && (
                  <div className="px-2">
                    <input
                      type="checkbox"
                      checked={selection.has(node.relPath)}
                      onChange={() => toggleSel(node.relPath)}
                    />
                  </div>
                )}
                {/* 状态图标（文件夹为聚合状态 + 差异计数） */}
                <div className="px-1 flex justify-center" title={icon.label}>
                  {node.isDir ? (
                    <button
                      className="w-5 h-5 rounded font-mono text-[13px] leading-5 text-center text-blue-600 hover:bg-blue-200"
                      onClick={() => toggleExpand(node.relPath)}
                      title={`${icon.label}（点击${isExpanded ? '折叠' : '展开'}）`}
                    >
                      {isExpanded ? '▾' : '▸'}
                    </button>
                  ) : (
                    <span className={`w-5 h-5 rounded font-mono text-[13px] leading-5 text-center ${icon.cls}`}>
                      {icon.icon}
                    </span>
                  )}
                </div>
                {/* 名称 ×N 侧 */}
                {Array.from({ length: n }, (_, side) => {
                  const has = node.present[side];
                  const tint = cellTint(node, side);
                  const clsLetter =
                    !node.isDir &&
                    n >= 3 &&
                    !node.entry!.allEqual &&
                    node.entry!.multi?.[side].present &&
                    node.entry!.multi?.[side].cls !== ABSENT
                      ? `[${classLetter(node.entry!.multi[side].cls)}]`
                      : '';
                  return (
                    <div
                      key={`n${side}`}
                      className={`px-2 truncate font-mono border-l border-r border-neutral-200 ${tint} ${has ? '' : STRIPE}`}
                      style={{ paddingLeft: 8 + depth * 16 }}
                      title={has ? (side === 0 && node.entry?.oldPath ? node.entry.oldPath : node.relPath) : '此侧不存在'}
                    >
                      {has ? (
                        <>
                          {node.isDir ? '📁 ' : ''}
                          {side === 0 && node.entry?.oldPath ? node.entry.oldPath : node.name}
                          {clsLetter && <span className="ml-1 text-[10px] text-neutral-500">{clsLetter}</span>}
                          {node.isDir && (node.different > 0 || node.missing > 0 || node.newer > 0) && (
                            <span className="ml-1.5 text-[10px] text-neutral-500">
                              {node.different > 0 && <span className="text-red-600">≠{node.different} </span>}
                              {node.missing > 0 && <span className="text-blue-600">缺{node.missing} </span>}
                              {node.newer > 0 && <span className="text-amber-600">新{node.newer}</span>}
                            </span>
                          )}
                        </>
                      ) : (
                        ''
                      )}
                    </div>
                  );
                })}
                {/* 中缝复制按钮（两路 FS） */}
                {twoWayFs && (
                  <div className="flex items-center justify-center gap-0.5 border-x border-neutral-200 bg-neutral-50/60">
                    {node.present[1] && (
                      <button
                        className="w-5 h-5 px-1 text-[11px] leading-4 rounded text-blue-700 hover:bg-blue-200 disabled:opacity-30"
                        title="复制到左侧 ◀"
                        disabled={busy > 0}
                        onClick={() => copyOne(node.relPath, 'toLeft')}
                      >
                        ◀
                      </button>
                    )}
                    {node.present[0] && (
                      <button
                        className="w-5 h-5 px-1 text-[11px] leading-4 rounded text-blue-700 hover:bg-blue-200 disabled:opacity-30"
                        title="复制到右侧 ▶"
                        disabled={busy > 0}
                        onClick={() => copyOne(node.relPath, 'toRight')}
                      >
                        ▶
                      </button>
                    )}
                  </div>
                )}
                {/* 大小 ×N */}
                {Array.from({ length: n }, (_, side) => {
                  const m = node.isDir ? node.dirEntry?.multi?.[side] : node.entry?.multi?.[side];
                  return (
                    <div
                      key={`s${side}`}
                      className={`px-2 text-right text-neutral-500 tabular-nums border-r border-neutral-200 ${
                        node.present[side] ? cellTint(node, side) : ''
                      }`}
                    >
                      {node.present[side] && !node.isDir ? formatSize(m?.size ?? null) : ''}
                    </div>
                  );
                })}
                {twoWayFs && (
                  <div className="px-2 text-neutral-400 border-r border-neutral-200">
                    {formatTime(node.isDir ? node.dirEntry?.leftMtime ?? null : node.entry?.leftMtime ?? null)}
                  </div>
                )}
                {twoWayFs && (
                  <div className="px-2 text-neutral-400">
                    {formatTime(node.isDir ? node.dirEntry?.rightMtime ?? null : node.entry?.rightMtime ?? null)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {entries && visibleRows.length === 0 && !loading && (
          <div className="py-10 text-center text-neutral-400 text-sm">
            {onlyDiff ? '没有差异 🎉（取消「只看不同」查看全部）' : '没有差异 🎉'}
          </div>
        )}
      </div>
    </div>
  );
}
