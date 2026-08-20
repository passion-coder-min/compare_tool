// Git 树视图：双车道提交图（base 侧 / target 侧 / 分叉点），
// target 侧提交可勾选 cherry-pick 到当前分支；冲突时切换为冲突处理面板。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { confirm } from '@tauri-apps/plugin-dialog';
import { api } from '../../lib/tauri';
import type { ConflictFile, GraphData, StatusEntry } from '../../lib/types';
import { joinPath } from '../../lib/utils';
import { toast } from '../../stores/toast';
import { useCompare } from '../../stores/compare';

const LANE_X = [16, 44] as const;
const LANE_AREA_W = 64;
const ROW_H = 40;

const LANE_COLOR = ['#3b82f6', '#22c55e'] as const; // base 蓝 / target 绿

export function GitTreeView({
  repo,
  base,
  target,
  refreshKey,
}: {
  repo: string;
  base: string;
  target: string;
  refreshKey: number;
}) {
  const openText = useCompare((s) => s.openText);

  const [graph, setGraph] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<{ failedSha: string; files: ConflictFile[] } | null>(null);
  const [dirtyFiles, setDirtyFiles] = useState<StatusEntry[] | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const g = await api.gitGraph(repo, base, target);
      setGraph(g);
      setSelected(new Set());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [repo, base, target]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const alreadySet = useMemo(
    () => new Set(graph?.already_in_current ?? []),
    [graph],
  );

  /** 可摘取的 target 侧提交（未在当前分支中） */
  const pickable = useMemo(
    () => (graph?.commits ?? []).filter((c) => c.lane === 1 && !alreadySet.has(c.sha)),
    [graph, alreadySet],
  );

  /** 每条车道最后出现的行号（车道线从最新提交延伸到分叉点） */
  const laneLastRow = useMemo(() => {
    const last = [-1, -1];
    (graph?.commits ?? []).forEach((c, i) => {
      last[c.lane] = i;
    });
    return last;
  }, [graph]);

  const toggleSha = (sha: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sha)) next.delete(sha);
      else next.add(sha);
      return next;
    });

  const allSelected = pickable.length > 0 && selected.size === pickable.length;

  const cherryPick = async () => {
    if (!graph || selected.size === 0) return;
    setBusy(true);
    try {
      const result = await api.gitCherryPick(repo, [...selected]);
      if (result.type === 'success') {
        toast.success(`已 cherry-pick ${result.picked.length} 个提交到 ${graph.current_branch}`);
        await load();
      } else if (result.type === 'dirty') {
        setDirtyFiles(result.files);
      } else {
        setConflict({ failedSha: result.failed_sha, files: result.files });
        toast.info('cherry-pick 遇到冲突，请解决后继续');
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  const openConflictFile = async (path: string) => {
    setBusy(true);
    try {
      const ours = await api.gitFileContent(repo, ':2', path);
      openText({
        sides: [
          { content: ours, label: `ours(HEAD):${path}` },
          { path: joinPath(repo, path), label: `工作区:${path}` },
        ],
        editableLast: true,
        title: `冲突：${path}`,
      });
    } catch (e) {
      toast.error(`读取冲突文件失败: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const continuePick = async () => {
    if (!conflict) return;
    setBusy(true);
    try {
      const short = await api.gitCherryPickContinue(
        repo,
        conflict.files.map((f) => f.path),
      );
      toast.success(`冲突已解决，生成提交 ${short}`);
      setConflict(null);
      await load();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  const abortPick = async () => {
    const yes = await confirm('确定放弃进行中的 cherry-pick 吗？工作区将回到操作前状态。', {
      title: '放弃 cherry-pick',
      kind: 'warning',
    });
    if (!yes) return;
    setBusy(true);
    try {
      await api.gitCherryPickAbort(repo);
      toast.info('已放弃 cherry-pick');
      setConflict(null);
      await load();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* 工具栏 */}
      <header className="flex items-center gap-2 px-3 py-1.5 border-b bg-neutral-50 text-sm shrink-0 flex-wrap">
        <span className="flex items-center gap-1 text-xs text-neutral-500">
          <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: LANE_COLOR[0] }} />
          {base}
          <span className="mx-1">·</span>
          <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: LANE_COLOR[1] }} />
          {target}
          <span className="mx-1">·</span>
          ◆ 分叉点
        </span>
        {graph && (
          <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-xs font-medium">
            当前分支：{graph.current_branch}
          </span>
        )}
        <div className="flex-1" />
        {busy && <span className="text-xs text-blue-500">处理中…</span>}
        <label className="flex items-center gap-1 text-xs text-neutral-600 cursor-pointer">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={() =>
              setSelected(allSelected ? new Set() : new Set(pickable.map((c) => c.sha)))
            }
          />
          全选可摘取
        </label>
        <button className="btn-primary" onClick={cherryPick} disabled={busy || selected.size === 0}>
          🍒 Cherry-pick（{selected.size}）→ {graph?.current_branch ?? '当前分支'}
        </button>
      </header>

      {error && (
        <div className="px-3 py-1.5 bg-red-50 text-red-600 text-xs border-b border-red-200 break-all">
          {error}
        </div>
      )}

      {/* 冲突处理模式：发生冲突时替代提交图操作 */}
      {conflict && (
        <div className="mx-3 mt-2 border border-red-300 rounded bg-red-50 p-3 text-sm space-y-2 shrink-0">
          <div className="font-medium text-red-700">
            cherry-pick 冲突：{conflict.failedSha.slice(0, 8)}
          </div>
          <div className="text-xs text-neutral-600">
            以下文件存在冲突，点击「编辑解决」修改并保存后，回到本页签点击继续：
          </div>
          <div className="max-h-40 overflow-auto divide-y divide-red-100 border border-red-200 rounded bg-white">
            {conflict.files.map((f) => (
              <div key={f.path} className="flex items-center gap-2 px-2 py-1.5">
                <span className="font-mono text-xs flex-1 truncate" title={f.path}>
                  {f.path}
                </span>
                <button className="btn" onClick={() => openConflictFile(f.path)} disabled={busy}>
                  ✎ 编辑解决
                </button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <button className="btn-primary" onClick={continuePick} disabled={busy}>
              ✓ 全部已解决，继续 cherry-pick
            </button>
            <button className="btn" onClick={abortPick} disabled={busy}>
              ✕ 放弃
            </button>
          </div>
        </div>
      )}

      {/* 工作区不干净 */}
      {dirtyFiles && (
        <div className="mx-3 mt-2 border border-amber-300 rounded bg-amber-50 p-3 text-sm space-y-2 shrink-0">
          <div className="font-medium text-amber-700">工作区不干净，无法 cherry-pick</div>
          <div className="text-xs text-neutral-600">请先提交或贮藏以下改动：</div>
          <div className="max-h-40 overflow-auto border border-amber-200 rounded bg-white font-mono text-xs">
            {dirtyFiles.map((f) => (
              <div key={f.path} className="px-2 py-1 border-b border-amber-100 last:border-0">
                {f.xy} {f.path}
              </div>
            ))}
          </div>
          <button className="btn" onClick={() => setDirtyFiles(null)}>
            知道了
          </button>
        </div>
      )}

      {/* 提交图 */}
      <div className="flex-1 overflow-auto">
        {loading && !graph && (
          <div className="py-10 text-center text-sm text-neutral-400">加载提交图…</div>
        )}
        {graph && graph.commits.length === 0 && !loading && (
          <div className="py-10 text-center text-sm text-neutral-400">
            {base} 与 {target} 之间没有分叉提交 🎉
          </div>
        )}
        {graph?.commits.map((c, i) => {
          const isAlready = alreadySet.has(c.sha);
          const pickableRow = c.lane === 1 && !isAlready;
          return (
            <div
              key={c.sha}
              className="flex items-center gap-2 px-3 border-b border-neutral-100 hover:bg-blue-50/40"
              style={{ height: ROW_H }}
            >
              {/* 车道区 */}
              <div className="relative shrink-0 self-stretch" style={{ width: LANE_AREA_W }}>
                {LANE_X.map((x, lane) =>
                  i <= laneLastRow[lane] ? (
                    <div
                      key={lane}
                      className="absolute top-0 bottom-0 w-0.5"
                      style={{ left: x, background: LANE_COLOR[lane] }}
                    />
                  ) : null,
                )}
                <div
                  className="absolute w-3.5 h-3.5 rounded-full border-2 bg-white"
                  style={{
                    left: LANE_X[c.lane] - 6,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    borderColor: LANE_COLOR[c.lane],
                  }}
                />
              </div>
              {/* 提交信息 */}
              {pickableRow ? (
                <input type="checkbox" checked={selected.has(c.sha)} onChange={() => toggleSha(c.sha)} />
              ) : (
                <span className="w-4" />
              )}
              <span className="font-mono text-xs text-blue-600 shrink-0" title={c.sha}>
                {c.short}
              </span>
              <span className="text-xs text-neutral-500 shrink-0 w-24 truncate">{c.author}</span>
              <span className="text-xs text-neutral-400 shrink-0">
                {new Date(c.timestamp * 1000).toLocaleDateString()}
              </span>
              <span className={'text-xs truncate flex-1 ' + (isAlready ? 'text-neutral-400 line-through' : '')}>
                {c.message}
              </span>
              {isAlready && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-200 text-neutral-500 shrink-0">
                  已在当前分支
                </span>
              )}
              {c.lane === 0 && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-500 shrink-0">
                  {base}
                </span>
              )}
            </div>
          );
        })}
        {/* 分叉点（汇合行） */}
        {graph?.merge_base && (
          <div className="flex items-center gap-2 px-3 bg-neutral-50" style={{ height: ROW_H }}>
            <div className="relative shrink-0 self-stretch" style={{ width: LANE_AREA_W }}>
              {/* 两条车道在下半段汇入中点 */}
              {LANE_X.map((x, lane) =>
                laneLastRow[lane] >= 0 ? (
                  <div
                    key={lane}
                    className="absolute top-0 h-1/2 w-0.5"
                    style={{ left: x, background: LANE_COLOR[lane] }}
                  />
                ) : null,
              )}
              <div
                className="absolute w-0 h-0"
                style={{
                  left: LANE_AREA_W / 2 - 6,
                  top: '50%',
                  transform: 'translateY(-50%) rotate(45deg)',
                  width: 10,
                  height: 10,
                  background: '#a8a29e',
                }}
              />
            </div>
            <span className="text-xs text-neutral-500">◆ 分叉点（共同祖先）</span>
            <span className="text-xs text-neutral-400">
              此后的提交为两侧共有历史
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
