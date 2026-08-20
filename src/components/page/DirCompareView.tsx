// 统一目录对比视图（Beyond Compare 风格 N 栏布局）：
// 两路目录：完整状态（仅一侧/不同/较新）+ 复制/删除操作；
// 多路目录（3-4 路）：相等类字母标记（同字母 = 内容相同），只读；
// git 分支（两路）：git 状态徽标。双击文件行切到文本对比页签。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { confirm } from '@tauri-apps/plugin-dialog';
import { useVirtualizer } from '@tanstack/react-virtual';
import { api } from '../../lib/tauri';
import type { DirStatus } from '../../lib/types';
import { formatSize, formatTime, joinPath } from '../../lib/utils';
import { toast } from '../../stores/toast';
import type { SourceSpec } from '../../stores/compare';

const STATUS_META: Record<DirStatus, { icon: string; label: string; cls: string }> = {
  only_left: { icon: '<', label: '仅左侧', cls: 'text-blue-700 bg-blue-100' },
  only_right: { icon: '>', label: '仅右侧', cls: 'text-blue-700 bg-blue-100' },
  same: { icon: '=', label: '相同', cls: 'text-neutral-400 bg-neutral-100' },
  different: { icon: '≠', label: '不同', cls: 'text-red-700 bg-red-200 font-bold' },
  left_newer: { icon: '→', label: '左侧较新', cls: 'text-amber-700 bg-amber-100' },
  right_newer: { icon: '←', label: '右侧较新', cls: 'text-amber-700 bg-amber-100' },
  error: { icon: '!', label: '错误', cls: 'text-red-700 bg-red-100' },
};

const GIT_STATUS_META: Record<string, { icon: string; cls: string; hint: string }> = {
  M: { icon: '≠', cls: 'text-red-700 bg-red-200 font-bold', hint: '两侧均有但内容不同' },
  A: { icon: '>', cls: 'text-emerald-700 bg-emerald-100', hint: '仅右侧（新增）' },
  D: { icon: '<', cls: 'text-red-700 bg-red-100', hint: '仅左侧（删除）' },
  R: { icon: '→', cls: 'text-blue-700 bg-blue-100', hint: '重命名' },
  C: { icon: '≫', cls: 'text-blue-700 bg-blue-100', hint: '复制' },
  T: { icon: '≀', cls: 'text-purple-700 bg-purple-100', hint: '类型变更' },
};

const STRIPE =
  'bg-[repeating-linear-gradient(45deg,transparent,transparent_6px,#f5f5f5_6px,#f5f5f5_12px)]';
const ABSENT = 4294967295; // Rust usize::MAX

export interface UnifiedEntry {
  relPath: string;
  isDir: boolean;
  /** 两路 FS 模式状态 */
  fsStatus?: DirStatus;
  /** git 模式状态字母 */
  gitStatus?: string;
  oldPath?: string | null;
  /** 多路模式：每侧 (present, size)；以及相等类 */
  multi?: { present: boolean; size: number | null; mtime: number | null; cls: number }[];
  allEqual?: boolean;
  leftMtime: number | null;
  rightMtime: number | null;
  error?: string | null;
}

const ROW_H = 30;

const classLetter = (c: number) => String.fromCharCode('a'.charCodeAt(0) + c);

export function DirCompareView({
  sources,
  onOpenFile,
}: {
  sources: SourceSpec[];
  onOpenFile: (e: UnifiedEntry) => void;
}) {
  const n = sources.length;
  const gitMode = n === 2 && sources[0].kind === 'git' && sources[1].kind === 'git' && (sources[0] as { repo: string }).repo === (sources[1] as { repo: string }).repo;
  const multiDirMode = !gitMode && sources.every((s) => s.kind === 'dir') && n >= 3;

  const [entries, setEntries] = useState<UnifiedEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [useHash, setUseHash] = useState(false);
  const [busy, setBusy] = useState(0);

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

  const stats = useMemo(() => {
    const s = { different: 0, onlyOne: 0, total: 0 };
    for (const e of entries ?? []) {
      s.total++;
      const present = (e.multi ?? []).filter((x) => x.present).length;
      if (present < n) s.onlyOne++;
      else if (!e.allEqual && e.fsStatus !== 'same') s.different++;
    }
    return s;
  }, [entries, n]);

  const selectedEntries = useMemo(
    () => (entries ?? []).filter((e) => selection.has(e.relPath)),
    [entries, selection],
  );

  const toggle = (rel: string) =>
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });

  const allSelected = (entries?.length ?? 0) > 0 && selectedEntries.length === (entries?.length ?? 0);
  const toggleAll = () =>
    setSelection(allSelected ? new Set() : new Set((entries ?? []).map((e) => e.relPath)));

  const copyTo = async (side: 'left' | 'right') => {
    if (!fsDirs) return;
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
    if (!fsDirs) return;
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

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: entries?.length ?? 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 25,
  });

  // 动态栅格：[勾选(两路)] [状态] [名称×N] [大小×N] [时间×N(两路FS)]
  const gridTemplate = useMemo(() => {
    let t = '';
    if (twoWayFs) t += '2.5rem ';
    t += '4rem ';
    for (let i = 0; i < n; i++) t += 'minmax(0,1fr) 6rem ';
    if (twoWayFs) t += '10.5rem 10.5rem';
    return t.trim();
  }, [n, twoWayFs]);

  const openable = (e: UnifiedEntry) =>
    !e.isDir &&
    (e.gitStatus
      ? true
      : (e.multi ?? []).filter((x) => x.present).length >= 2);

  const iconOf = (e: UnifiedEntry): { icon: string; cls: string; label: string } => {
    if (e.gitStatus) {
      const m = GIT_STATUS_META[e.gitStatus] ?? GIT_STATUS_META.M;
      return { icon: m.icon, cls: m.cls, label: m.hint };
    }
    if (e.fsStatus) {
      const m = STATUS_META[e.fsStatus];
      return { icon: m.icon, cls: m.cls, label: m.label };
    }
    // 多路
    const present = (e.multi ?? []).filter((x) => x.present).length;
    if (present < n) return { icon: '◇', cls: 'text-blue-700 bg-blue-100', label: `仅 ${present} 侧存在` };
    if (e.allEqual) return { icon: '=', cls: 'text-neutral-400 bg-neutral-100', label: '各侧相同' };
    return { icon: '≠', cls: 'text-red-700 bg-red-200 font-bold', label: '各侧存在差异' };
  };

  return (
    <div className="h-full flex flex-col">
      {/* 工具栏 */}
      <header className="flex items-center gap-2 px-3 py-1.5 border-b bg-neutral-50 text-sm shrink-0 flex-wrap">
        <span className="text-xs text-neutral-500">
          {gitMode
            ? `🌿 ${(sources[0] as { ref: string }).ref}...${(sources[1] as { ref: string }).ref} 之间 ${stats.total} 个文件改动`
            : `${n} 路 · ${stats.total} 项：≠ ${stats.different} · 缺失 ${stats.onlyOne}`}
        </span>
        <span className="text-[11px] text-neutral-400">双击行查看文件差异</span>
        {twoWayFs && (
          <label className="flex items-center gap-1 text-xs text-neutral-600 cursor-pointer">
            <input type="checkbox" checked={useHash} onChange={(e) => setUseHash(e.target.checked)} />
            内容哈希精确比较
          </label>
        )}
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
        {multiDirMode && <span className="text-xs text-neutral-400">多路模式只读</span>}
        {gitMode && <span className="text-xs text-neutral-400">摘取提交请切到「Git 树」页签</span>}
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
        {sources.map((_, i) => (
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
        {sources.map((_, i) => (
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
            const e = entries![vi.index];
            const icon = iconOf(e);
            const nameTint = (s: { present: boolean; cls: number }) => {
              if (!s.present) return '';
              if (e.allEqual) return '';
              if (e.gitStatus) {
                return e.gitStatus === 'A'
                  ? 'bg-emerald-100'
                  : e.gitStatus === 'R' || e.gitStatus === 'C'
                    ? 'bg-blue-100'
                    : 'bg-red-100';
              }
              if (e.fsStatus) {
                if (e.fsStatus === 'left_newer') return s === e.multi![0] ? 'bg-amber-100' : '';
                if (e.fsStatus === 'right_newer') return s === e.multi![1] ? 'bg-amber-100' : '';
                if (e.fsStatus === 'same') return '';
                return 'bg-red-100';
              }
              return 'bg-red-100';
            };
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
                onDoubleClick={() => openable(e) && onOpenFile(e)}
                title={e.error ?? '双击打开文件对比'}
              >
                <RowCells
                  entry={e}
                  icon={icon}
                  twoWayFs={twoWayFs}
                  n={n}
                  selected={selection.has(e.relPath)}
                  onToggle={() => toggle(e.relPath)}
                  nameTint={nameTint}
                />
              </div>
            );
          })}
        </div>
        {entries && entries.length === 0 && !loading && (
          <div className="py-10 text-center text-neutral-400 text-sm">没有差异 🎉</div>
        )}
      </div>
    </div>
  );
}

function RowCells({
  entry,
  icon,
  twoWayFs,
  n,
  selected,
  onToggle,
  nameTint,
}: {
  entry: UnifiedEntry;
  icon: { icon: string; cls: string; label: string };
  twoWayFs: boolean;
  n: number;
  selected: boolean;
  onToggle: () => void;
  nameTint: (s: { present: boolean; cls: number }) => string;
}) {
  return (
    <>
      {twoWayFs && (
        <div className="px-2">
          <input type="checkbox" checked={selected} onChange={onToggle} />
        </div>
      )}
      <div className="px-1 flex justify-center" title={icon.label + (entry.error ? `：${entry.error}` : '')}>
        <span className={`w-5 h-5 rounded font-mono text-[13px] leading-5 text-center ${icon.cls}`}>
          {icon.icon}
        </span>
      </div>
      {(entry.multi ?? []).map((s, i) => (
        <div
          key={`n${i}`}
          className={`px-2 truncate font-mono border-l border-r border-neutral-200 ${nameTint(s)} ${
            s.present ? '' : STRIPE
          }`}
          title={s.present ? (i === 0 && entry.oldPath ? entry.oldPath : entry.relPath) : '此侧不存在'}
        >
          {s.present
            ? (entry.isDir ? '📁 ' : '') + (i === 0 && entry.oldPath ? entry.oldPath : entry.relPath)
            : ''}
          {s.present && n >= 3 && !entry.allEqual && s.cls !== ABSENT && (
            <span className="ml-1 text-[10px] text-neutral-500">[{classLetter(s.cls)}]</span>
          )}
        </div>
      ))}
      {(entry.multi ?? []).map((s, i) => (
        <div
          key={`s${i}`}
          className={`px-2 text-right text-neutral-500 tabular-nums border-r border-neutral-200 ${nameTint(s)}`}
        >
          {s.present ? formatSize(s.size) : ''}
        </div>
      ))}
      {twoWayFs && (
        <div className="px-2 text-neutral-400 border-r border-neutral-200">
          {formatTime(entry.leftMtime)}
        </div>
      )}
      {twoWayFs && <div className="px-2 text-neutral-400">{formatTime(entry.rightMtime)}</div>}
    </>
  );
}
