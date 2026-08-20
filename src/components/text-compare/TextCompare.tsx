// N 路文本对比视图（2-4 栏并排对齐）：
// 行槽位矩阵由 Rust 端按基准侧对齐计算；差异行整行着色 + 行内字符级高亮；
// 最后一侧可编辑（磁盘文件），倒数第二栏与末栏之间的中缝提供块级合并（▶ 采纳 / ✕ 丢弃）。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { api } from '../../lib/tauri';
import type { DiffLine, InlineSpan, LineKind, MultiTextDiff } from '../../lib/types';
import { basename } from '../../lib/utils';
import { toast } from '../../stores/toast';
import type { TextSession } from '../../stores/compare';

const ROW_H = 24;

const BG: Record<LineKind, string> = {
  delete: 'bg-red-100',
  insert: 'bg-emerald-100',
  equal: '',
};
const STRIPE =
  'bg-[repeating-linear-gradient(45deg,transparent,transparent_6px,#f5f5f5_6px,#f5f5f5_12px)]';
const PANE_HEADER_TINT = ['bg-blue-50/70', 'bg-emerald-50/70', 'bg-amber-50/70', 'bg-violet-50/70'];

function Segments({ text, spans, hl }: { text: string; spans: InlineSpan[]; hl: string }) {
  if (spans.length === 0) return <>{text}</>;
  const chars = Array.from(text);
  const out: React.ReactNode[] = [];
  let pos = 0;
  spans.forEach((s, i) => {
    const start = Math.min(Math.max(s.start, pos), chars.length);
    const end = Math.min(s.end, chars.length);
    if (start > pos) out.push(chars.slice(pos, start).join(''));
    if (end > start) {
      out.push(
        <span key={i} className={hl}>
          {chars.slice(start, end).join('')}
        </span>,
      );
    }
    pos = Math.max(pos, end);
  });
  if (pos < chars.length) out.push(chars.slice(pos).join(''));
  return <>{out}</>;
}

/** 一行是否所有侧完全一致 */
function rowAllEqual(row: (DiffLine | null)[]): boolean {
  return row.length > 0 && row.every((s) => s !== null && s.kind === 'equal');
}

export function TextCompare({ session }: { session: TextSession }) {
  const n = session.sides.length;
  const lastEditable = session.editableLast && !!session.sides[n - 1].path;

  const [texts, setTexts] = useState<(string | null)[]>(() => session.sides.map(() => null));
  const [savedLast, setSavedLast] = useState<string | null>(null);
  const [endsWithNL, setEndsWithNL] = useState(true);
  const [result, setResult] = useState<MultiTextDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [foldEnabled, setFoldEnabled] = useState(false);
  const [folded, setFolded] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<{ displayIdx: number; lineNo: number; value: string } | null>(null);
  const [navPos, setNavPos] = useState(-1);
  // 原文编辑模式（空白对比默认开启；任何会话均可手动切换）
  const [rawEdit, setRawEdit] = useState(!!session.scratch);
  // 输入防抖后的文本（驱动 diff 计算）
  const [debouncedTexts, setDebouncedTexts] = useState<(string | null)[]>(() => session.sides.map(() => null));

  // ---------- 数据加载 ----------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const loaded: string[] = [];
        for (const side of session.sides) {
          loaded.push(
            side.content !== undefined ? side.content : (await api.readTextFile(side.path!)).content,
          );
        }
        if (cancelled) return;
        setTexts(loaded);
        setSavedLast(loaded[n - 1]);
        setEndsWithNL(loaded[n - 1].length > 0 && /(\r?\n|\r)$/.test(loaded[n - 1]));
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // ---------- diff 计算（防抖） ----------

  useEffect(() => {
    const t = setTimeout(() => setDebouncedTexts(texts), session.scratch ? 400 : 0);
    return () => clearTimeout(t);
  }, [texts, session.scratch]);

  useEffect(() => {
    if (debouncedTexts.some((t) => t === null)) return;
    let cancelled = false;
    api
      .compareTextMulti(debouncedTexts as string[])
      .then((r) => {
        if (cancelled) return;
        setResult(r);
        setNavPos(-1);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedTexts]);

  const rows = result?.rows ?? [];

  // ---------- 折叠块 ----------
  const foldBlocks = useMemo(() => {
    const MIN_FOLD = 10;
    const CTX = 3;
    const blocks: { start: number; end: number }[] = [];
    let s = -1;
    for (let i = 0; i <= rows.length; i++) {
      const isEq = i < rows.length && rowAllEqual(rows[i]);
      if (isEq && s < 0) s = i;
      if (!isEq && s >= 0) {
        if (i - s >= MIN_FOLD) blocks.push({ start: s + CTX, end: i - CTX });
        s = -1;
      }
    }
    return blocks;
  }, [rows]);

  useEffect(() => {
    setFolded(new Set(foldBlocks.map((_, i) => i)));
  }, [foldBlocks]);

  const toggleFold = (blockIdx: number) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(blockIdx)) next.delete(blockIdx);
      else next.add(blockIdx);
      return next;
    });

  const displayItems = useMemo(() => {
    const items: {
      kind: 'row' | 'fold';
      orig: number;
      row?: (DiffLine | null)[];
      hidden?: number;
      block?: number;
    }[] = [];
    for (let i = 0; i < rows.length; i++) {
      const b = foldBlocks.findIndex((bl) => i >= bl.start && i < bl.end);
      if (b >= 0 && foldEnabled && folded.has(b)) {
        if (i === foldBlocks[b].start) {
          items.push({ kind: 'fold', orig: i, hidden: foldBlocks[b].end - foldBlocks[b].start, block: b });
        }
        continue;
      }
      items.push({ kind: 'row', orig: i, row: rows[i] });
    }
    return items;
  }, [rows, foldBlocks, foldEnabled, folded]);

  // ---------- 差异块 ----------
  const diffBlocks = useMemo(() => {
    const blocks: { start: number; end: number }[] = [];
    let s = -1;
    for (let i = 0; i <= rows.length; i++) {
      const isDiff = i < rows.length && !rowAllEqual(rows[i]);
      if (isDiff && s < 0) s = i;
      if (!isDiff && s >= 0) {
        blocks.push({ start: s, end: i });
        s = -1;
      }
    }
    return blocks;
  }, [rows]);

  // ---------- 编辑与块操作（作用于最后一侧） ----------

  const mutateLast = useCallback(
    (fn: (lines: string[]) => void) => {
      if (!result || texts[n - 1] === null) return;
      const lines: string[] = [];
      let maxNo = 0;
      for (const row of rows) {
        const slot = row[n - 1];
        if (slot?.number != null) {
          lines[slot.number - 1] = slot.text;
          maxNo = Math.max(maxNo, slot.number);
        }
      }
      for (let i = 0; i < maxNo; i++) if (lines[i] === undefined) lines[i] = '';
      fn(lines);
      const eol = result.eols[n - 1] ?? '\n';
      setTexts((prev) => {
        const next = [...prev];
        next[n - 1] = lines.join(eol) + (endsWithNL ? eol : '');
        return next;
      });
    },
    [result, rows, texts, n, endsWithNL],
  );

  /** 把倒数第二栏的差异块内容采纳到最后一侧 */
  const applyAdjacentBlock = useCallback(
    (block: { start: number; end: number }) => {
      if (n < 2) return;
      const src = n - 2;
      mutateLast((lines) => {
        const blockRows = rows.slice(block.start, block.end);
        const srcTexts = blockRows.map((r) => r[src]?.text).filter((t): t is string => t !== undefined);
        const dstNos = blockRows
          .map((r) => r[n - 1]?.number)
          .filter((x): x is number => x != null);
        if (dstNos.length > 0) {
          lines.splice(dstNos[0] - 1, dstNos.length, ...srcTexts);
        } else {
          let insertAt = lines.length;
          for (let i = block.end; i < rows.length; i++) {
            const no = rows[i][n - 1]?.number;
            if (no != null) {
              insertAt = no - 1;
              break;
            }
          }
          lines.splice(insertAt, 0, ...srcTexts);
        }
      });
    },
    [n, rows, mutateLast],
  );

  const dropLastBlock = useCallback(
    (block: { start: number; end: number }) => {
      mutateLast((lines) => {
        const nos = rows
          .slice(block.start, block.end)
          .map((r) => r[n - 1]?.number)
          .filter((x): x is number => x != null);
        if (nos.length > 0) lines.splice(nos[0] - 1, nos.length);
      });
    },
    [rows, n, mutateLast],
  );

  // ---------- 保存（最后一侧） ----------

  const dirty = texts[n - 1] !== null && texts[n - 1] !== savedLast;
  const canSave = lastEditable && dirty;

  const save = useCallback(async () => {
    const path = session.sides[n - 1].path;
    const lastText = texts[n - 1];
    if (!path || lastText === null || !dirty) return;
    try {
      await api.saveFile(path, lastText);
      setSavedLast(lastText);
      toast.success(`已保存 ${basename(path)}`);
    } catch (e) {
      toast.error(String(e));
    }
  }, [session, texts, n, dirty]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [save]);

  // ---------- 虚拟滚动 ----------

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: displayItems.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 20,
  });

  const goToBlock = (idx: number) => {
    if (idx < 0 || idx >= diffBlocks.length) return;
    setNavPos(idx);
    const startOrig = diffBlocks[idx].start;
    const di = displayItems.findIndex((it) => it.kind === 'row' && it.orig === startOrig);
    if (di >= 0) virtualizer.scrollToIndex(di, { align: 'start' });
  };

  // ---------- 动态栅格 ----------

  const gridTemplate = useMemo(() => {
    let t = '';
    for (let i = 0; i < n; i++) {
      t += '3rem minmax(0,1fr) ';
      if (i < n - 1) t += '2.5rem ';
    }
    return t.trim();
  }, [n]);

  const stats = result?.stats;

  return (
    <div className="h-full flex flex-col">
      {/* 工具栏 */}
      <header className="flex items-center gap-2 px-3 py-1.5 border-b bg-neutral-50 text-sm shrink-0">
        <button className="btn" onClick={() => goToBlock(navPos - 1)} disabled={diffBlocks.length === 0}>
          ◀
        </button>
        <button className="btn" onClick={() => goToBlock(navPos + 1)} disabled={diffBlocks.length === 0}>
          ▶
        </button>
        <span className="text-xs text-neutral-500 tabular-nums">
          {n} 路对比 ·{' '}
          {diffBlocks.length > 0 ? `差异 ${navPos + 1}/${diffBlocks.length}` : '无差异'}
          {stats ? `（${stats.changed} 行有改动）` : ''}
        </span>
        <label className="flex items-center gap-1 text-xs text-neutral-600 ml-2 cursor-pointer">
          <input type="checkbox" checked={foldEnabled} onChange={(e) => setFoldEnabled(e.target.checked)} />
          折叠相同区域
        </label>
        <button
          className="btn"
          onClick={() => setRawEdit((v) => !v)}
          title={rawEdit ? '切换到并排差异视图' : '切换到原始文本编辑（可粘贴多行）'}
        >
          {rawEdit ? '◫ 对比视图' : '✎ 编辑原文'}
        </button>
        <div className="flex-1" />
        {loading && <span className="text-xs text-blue-500">加载中…</span>}
        {canSave && (
          <button className="btn-primary" onClick={save} title="Ctrl+S">
            💾 保存
          </button>
        )}
        {lastEditable && (
          <span className={`text-xs ${dirty ? 'text-amber-600' : 'text-neutral-400'}`}>
            {dirty ? '● 未保存' : '已同步'}
          </span>
        )}
      </header>

      {error && (
        <div className="px-3 py-1.5 bg-red-50 text-red-600 text-xs border-b border-red-200 break-all">
          {error}
        </div>
      )}

      {/* 原文编辑模式（空白对比 / 粘贴多行场景） */}
      {rawEdit ? (
        <div
          className="flex-1 min-h-0 grid gap-2 p-2"
          style={{ gridTemplateColumns: `repeat(${n}, minmax(0,1fr))` }}
        >
          {session.sides.map((side, i) => (
            <div key={i} className="flex flex-col min-h-0 border border-neutral-300 rounded overflow-hidden bg-white">
              <div
                className={`px-2 py-1 text-xs border-b border-neutral-200 truncate ${PANE_HEADER_TINT[i % 4]}`}
                title={side.path ?? side.label}
              >
                {i === 0 ? '◀ ' : ''}
                {side.label}
                {i === n - 1 ? ' ▶' : ''}
              </div>
              <textarea
                className="flex-1 w-full font-mono text-[13px] leading-6 p-2 resize-none outline-none border-0 focus:ring-1 focus:ring-blue-400"
                value={texts[i] ?? ''}
                onChange={(e) =>
                  setTexts((prev) => {
                    const next = [...prev];
                    next[i] = e.target.value;
                    return next;
                  })
                }
                placeholder="在此粘贴或输入内容…"
                spellCheck={false}
              />
            </div>
          ))}
        </div>
      ) : (
      <>
      {/* 栏头 */}
      <div className="grid text-xs text-neutral-600 bg-neutral-50 border-b shrink-0" style={{ gridTemplateColumns: gridTemplate }}>
        {session.sides.map((side, i) => (
          <React.Fragment key={i}>
            <div
              className={`col-span-2 px-2 py-1 truncate border-r border-neutral-200 ${PANE_HEADER_TINT[i % 4]}`}
              title={side.path ?? side.label}
            >
              {i === 0 ? '◀ ' : i === n - 1 ? '' : ''}
              {side.label}
              {i === n - 1 ? ' ▶' : ''}
            </div>
            {i < n - 1 && <div className="border-r border-neutral-200 bg-neutral-100" />}
          </React.Fragment>
        ))}
      </div>

      {/* 多栏内容 */}
      <div ref={scrollRef} className="flex-1 overflow-auto font-mono text-[13px] leading-6">
        {result && rows.length === 0 && (
          <div className="h-full flex items-center justify-center text-emerald-600 text-sm font-sans">
            ✓ 各侧内容完全相同
          </div>
        )}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const item = displayItems[vi.index];
            const block = diffBlocks.find((b) => item.orig! >= b.start && item.orig! < b.end);
            const blockHasSrc = !!block && rows.slice(block.start, block.end).some((r) => r[n - 2]);
            const blockHasDst = !!block && rows.slice(block.start, block.end).some((r) => r[n - 1]);
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
                }}
              >
                {item.kind === 'fold' ? (
                  <button
                    onClick={() => toggleFold(item.block!)}
                    className="w-full h-full flex items-center justify-center gap-1 text-[11px] text-neutral-400
                      hover:text-neutral-600 hover:bg-neutral-50 font-sans"
                  >
                    ⋯ 展开 {item.hidden} 行相同内容 ⋯
                  </button>
                ) : (
                  <div className="grid h-full" style={{ gridTemplateColumns: gridTemplate }}>
                    {session.sides.map((_side, i) => (
                      <React.Fragment key={i}>
                        <PaneSlot
                          line={item.row![i]}
                          editable={lastEditable && i === n - 1}
                          editing={editing?.displayIdx === vi.index && i === n - 1 ? editing : null}
                          onEditStart={() => {
                            const slot = item.row![i];
                            if (slot?.number != null)
                              setEditing({ displayIdx: vi.index, lineNo: slot.number, value: slot.text });
                          }}
                          onEditCommit={(v) => {
                            mutateLast((lines) => {
                              lines[editing!.lineNo - 1] = v;
                            });
                            setEditing(null);
                          }}
                          onEditCancel={() => setEditing(null)}
                          onEditChange={(v) => editing && setEditing({ ...editing, value: v })}
                        />
                        {i < n - 1 && (
                          <div className="flex items-center justify-center gap-0.5 bg-neutral-50/60 border-x border-neutral-200">
                            {lastEditable && i === n - 2 && block && item.orig === block.start && blockHasSrc && (
                              <button
                                title="将此差异块采纳到最后一侧"
                                className="w-4 h-4 text-[10px] leading-none rounded text-emerald-700 hover:bg-emerald-200"
                                onClick={() => applyAdjacentBlock(block)}
                              >
                                ▶
                              </button>
                            )}
                            {lastEditable && i === n - 2 && block && item.orig === block.start && blockHasDst && (
                              <button
                                title="丢弃最后一侧此差异块"
                                className="w-4 h-4 text-[10px] leading-none rounded text-red-700 hover:bg-red-200"
                                onClick={() => dropLastBlock(block)}
                              >
                                ✕
                              </button>
                            )}
                          </div>
                        )}
                      </React.Fragment>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      </>
      )}
    </div>
  );
}

function PaneSlot({
  line,
  editable,
  editing,
  onEditStart,
  onEditCommit,
  onEditCancel,
  onEditChange,
}: {
  line: DiffLine | null;
  editable: boolean;
  editing: { value: string } | null;
  onEditStart: () => void;
  onEditCommit: (v: string) => void;
  onEditCancel: () => void;
  onEditChange: (v: string) => void;
}) {
  const tint = line ? BG[line.kind] : STRIPE;
  return (
    <>
      <div
        className={`text-right pr-1.5 text-neutral-400 text-xs leading-6 select-none tabular-nums truncate border-r border-neutral-200 ${tint}`}
      >
        {line?.number ?? ''}
      </div>
      <div
        className={`px-1 whitespace-pre overflow-hidden ${tint} ${editable && line ? 'cursor-text' : ''}`}
        onDoubleClick={() => editable && line && onEditStart()}
        title={line?.text}
      >
        {editing ? (
          <input
            autoFocus
            className="w-full bg-white outline-none ring-1 ring-blue-400 px-1 font-mono text-[13px]"
            value={editing.value}
            onChange={(e) => onEditChange(e.target.value)}
            onBlur={() => onEditCommit(editing.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onEditCommit((e.target as HTMLInputElement).value);
              if (e.key === 'Escape') onEditCancel();
            }}
          />
        ) : (
          line && <Segments text={line.text} spans={line.inline} hl={line.kind === 'delete' ? 'bg-red-300/80' : 'bg-emerald-300/80'} />
        )}
      </div>
    </>
  );
}
