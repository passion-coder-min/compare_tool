// N 路十六进制对比视图：每侧一个 hex dump 面板，各侧不全部相同的字节高亮，
// 窗口按需加载。作为页签视图使用（始终有磁盘路径）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { api } from '../../lib/tauri';
import type { HexOverviewMulti, HexRowMulti } from '../../lib/types';
import { basename, formatBytesHex, formatSize, hex } from '../../lib/utils';

const BYTES_PER_ROW = 16;
const WINDOW = 256; // 每次拉取的行数
const ROW_H = 22;

export function HexCompare({ paths }: { paths: string[] }) {
  const n = paths.length;
  const [overview, setOverview] = useState<HexOverviewMulti | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const cacheRef = useRef(new Map<number, HexRowMulti[]>());
  const pendingRef = useRef(new Set<number>());
  const [, setCacheVersion] = useState(0);

  const start = useCallback(async () => {
    setLoading(true);
    cacheRef.current.clear();
    setOverview(null);
    try {
      const ov = await api.hexOverviewMulti(paths);
      setOverview(ov);
      setError('');
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [paths]);

  useEffect(() => {
    start();
  }, [start]);

  const totalRows = overview
    ? Math.ceil(Math.max(...overview.sizes, 0) / BYTES_PER_ROW)
    : 0;

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: totalRows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 30,
  });

  // 可见区域需要的数据窗口按需拉取
  const virtualItems = virtualizer.getVirtualItems();
  useEffect(() => {
    if (virtualItems.length === 0) return;
    const missing: number[] = [];
    for (const v of virtualItems) {
      const w = Math.floor(v.index / WINDOW);
      if (!cacheRef.current.has(w) && !pendingRef.current.has(w) && !missing.includes(w)) {
        missing.push(w);
      }
    }
    if (missing.length === 0) return;
    missing.forEach((w) => pendingRef.current.add(w));
    (async () => {
      for (const w of missing) {
        try {
          const rows = await api.readHexWindowMulti(paths, w * WINDOW, WINDOW);
          cacheRef.current.set(w, rows);
        } catch (e) {
          setError(String(e));
          break;
        }
        pendingRef.current.delete(w);
      }
      setCacheVersion((v) => v + 1);
    })();
  }, [virtualItems, paths]);

  const getRow = (idx: number): HexRowMulti | null => {
    const w = Math.floor(idx / WINDOW);
    return cacheRef.current.get(w)?.[idx % WINDOW] ?? null;
  };

  const jumpToFirstDiff = () => {
    if (overview?.first_diff == null) return;
    virtualizer.scrollToIndex(Math.floor(overview.first_diff / BYTES_PER_ROW), { align: 'start' });
  };

  return (
    <div className="h-full flex flex-col">
      <header className="flex items-center gap-3 px-3 py-1.5 border-b bg-neutral-50 text-sm shrink-0 flex-wrap">
        {paths.map((p, i) => (
          <span
            key={i}
            className="truncate max-w-64 text-xs text-neutral-600"
            title={p}
          >
            {i === 0 ? '◀ ' : ''}
            {basename(p)}（{formatSize(overview?.sizes[i] ?? null)}）
            {i === n - 1 ? ' ▶' : ''}
          </span>
        ))}
        <div className="flex-1" />
        {overview?.identical && (
          <span className="text-xs text-emerald-600 font-medium">✓ 各侧文件内容完全相同</span>
        )}
        {overview && !overview.identical && overview.first_diff != null && (
          <span className="text-xs text-red-600">首个差异 @ {formatBytesHex(overview.first_diff)}</span>
        )}
        <button className="btn" onClick={jumpToFirstDiff} disabled={overview?.first_diff == null}>
          ⤓ 跳到首差异
        </button>
        <button className="btn" onClick={start} disabled={loading}>
          ⟳ 刷新
        </button>
      </header>

      {error && (
        <div className="px-3 py-1.5 bg-red-50 text-red-600 text-xs border-b border-red-200 break-all">
          {error}
        </div>
      )}
      {loading && (
        <div className="px-3 py-1 text-xs text-blue-500 border-b bg-blue-50/60">正在扫描差异…</div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-auto font-mono text-[12px] leading-[22px]">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const idx = vi.index;
            const row = getRow(idx);
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
                className="flex gap-4 px-3 whitespace-pre"
              >
                {Array.from({ length: n }, (_, side) => (
                  <HexPane key={side} row={row} idx={idx} />
                ))}
              </div>
            );
          })}
        </div>
        {totalRows === 0 && !loading && (
          <div className="py-10 text-center text-neutral-400 text-sm font-sans">空文件</div>
        )}
      </div>
    </div>
  );
}

function HexPane({ row, idx }: { row: HexRowMulti | null; idx: number }) {
  const offset = idx * BYTES_PER_ROW;
  const bytes = row?.sides.find((s) => s != null) ?? null;
  const diffs = new Set(row?.diff ?? []);

  const hexCells = Array.from({ length: BYTES_PER_ROW }, (_, i) => {
    const b = bytes?.[i];
    return { t: b === undefined ? '··' : hex(b, 2), d: diffs.has(i) };
  });
  const asciiCells = Array.from({ length: BYTES_PER_ROW }, (_, i) => {
    const b = bytes?.[i];
    const printable = b !== undefined && b >= 0x20 && b < 0x7f;
    return { t: b === undefined ? '·' : printable ? String.fromCharCode(b) : '·', d: diffs.has(i) };
  });

  const cell = (c: { t: string; d: boolean }, key: number, last: boolean) => (
    <span key={key} className={c.d ? 'bg-red-200 text-red-800 rounded-sm' : ''}>
      {c.t}
      {!last ? ' ' : ''}
    </span>
  );

  return (
    <div className="flex-1 min-w-0">
      <span className="text-neutral-400 mr-4 inline-block w-[10ch]">{hex(offset, 8)}</span>
      <span className={bytes === null ? 'text-neutral-300' : ''}>
        {hexCells.map((c, i) => cell(c, i, i === BYTES_PER_ROW - 1))}
      </span>
      <span className="ml-4 text-neutral-500">
        {asciiCells.map((c, i) => cell(c, i, i === BYTES_PER_ROW - 1))}
      </span>
    </div>
  );
}
