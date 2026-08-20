// 源选择器：一侧可为「文件」「目录」或「git 分支」，支持多路（2-4 侧）
import { useEffect, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { api } from '../../lib/tauri';
import type { RepoInfo } from '../../lib/types';
import { basename } from '../../lib/utils';
import { toast } from '../../stores/toast';
import type { SourceSpec } from '../../stores/compare';

type Mode = 'file' | 'dir' | 'git';

export function SourceSelector({
  index,
  total,
  source,
  onChange,
  onRemove,
}: {
  index: number;
  total: number;
  source: SourceSpec | null;
  onChange: (s: SourceSpec | null) => void;
  onRemove: () => void;
}) {
  const [localMode, setLocalMode] = useState<Mode>(source?.kind ?? 'dir');
  const [repoInfo, setRepoInfo] = useState<RepoInfo | null>(null);

  // 外部源变化（交换、演示预设）时同步本地模式
  useEffect(() => {
    setLocalMode(source?.kind ?? 'dir');
  }, [source]);

  useEffect(() => {
    if (source?.kind !== 'git') {
      setRepoInfo(null);
      return;
    }
    let cancelled = false;
    api
      .gitOpenRepo(source.repo)
      .then((info) => !cancelled && setRepoInfo(info))
      .catch(() => !cancelled && setRepoInfo(null));
    return () => {
      cancelled = true;
    };
  }, [source?.kind, source?.kind === 'git' ? source.repo : null]);

  const pickFile = async () => {
    const picked = await openDialog({
      multiple: false,
      title: `选择第 ${index + 1} 侧文件`,
    });
    if (typeof picked === 'string') onChange({ kind: 'file', path: picked });
  };

  const pickDir = async () => {
    const picked = await openDialog({
      multiple: false,
      directory: true,
      title: `选择第 ${index + 1} 侧目录`,
    });
    if (typeof picked === 'string') onChange({ kind: 'dir', path: picked });
  };

  const pickRepo = async () => {
    const picked = await openDialog({ multiple: false, directory: true, title: '选择 git 仓库' });
    if (typeof picked !== 'string') return;
    try {
      const info = await api.gitOpenRepo(picked);
      // 末侧默认当前分支，其余默认主分支
      const ref =
        index === total - 1
          ? info.current_branch
          : info.branches.find((b) => b === 'main' || b === 'master') ??
            info.branches.find((b) => b !== info.current_branch) ??
            info.current_branch;
      onChange({ kind: 'git', repo: info.root, ref });
    } catch {
      onChange(null);
      toast.error(`${picked} 不是有效的 git 仓库`);
    }
  };

  const setMode = (m: Mode) => {
    if (m === localMode) return;
    setLocalMode(m);
    onChange(null); // 重置该侧源
  };

  const label = total === 2 ? (index === 0 ? '左侧' : '右侧') : `侧${index + 1}`;

  const MODE_BTNS: { m: Mode; icon: string; title: string }[] = [
    { m: 'file', icon: '📄', title: '选择单个文件（直接文本/十六进制对比）' },
    { m: 'dir', icon: '📁', title: '选择目录（文件夹对比）' },
    { m: 'git', icon: '🌿', title: '选择同一仓库的分支（git 对比固定两路）' },
  ];

  return (
    <div className="flex items-center gap-1.5 min-w-0 flex-1">
      <span className="text-xs text-neutral-500 shrink-0 w-8">{label}</span>
      <div className="flex rounded border border-neutral-300 overflow-hidden shrink-0 text-xs">
        {MODE_BTNS.map(({ m, icon, title }) => (
          <button
            key={m}
            className={'px-2 py-1 ' + (localMode === m ? 'bg-blue-600 text-white' : 'bg-white text-neutral-600 hover:bg-neutral-50')}
            onClick={() => setMode(m)}
            title={title}
          >
            {icon}
          </button>
        ))}
      </div>

      {localMode === 'file' ? (
        <>
          <input
            className="field flex-1 min-w-0"
            readOnly
            value={source?.kind === 'file' ? source.path : ''}
            placeholder="选择文件…"
          />
          <button className="btn shrink-0" onClick={pickFile}>
            浏览…
          </button>
        </>
      ) : localMode === 'dir' ? (
        <>
          <input
            className="field flex-1 min-w-0"
            readOnly
            value={source?.kind === 'dir' ? source.path : ''}
            placeholder="选择目录…"
          />
          <button className="btn shrink-0" onClick={pickDir}>
            浏览…
          </button>
        </>
      ) : source?.kind === 'git' ? (
        <>
          <span className="text-xs text-neutral-600 truncate max-w-40 shrink-0" title={source.repo}>
            📁 {basename(source.repo)}
          </span>
          <select
            className="field flex-1 min-w-0"
            value={source.ref}
            onChange={(e) => onChange({ kind: 'git', repo: source.repo, ref: e.target.value })}
          >
            {(repoInfo?.branches ?? [source.ref]).map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
          <button className="btn shrink-0" onClick={pickRepo} title="重新选择仓库">
            …
          </button>
        </>
      ) : (
        <button className="btn flex-1" onClick={pickRepo}>
          选择 git 仓库…
        </button>
      )}
      {total > 2 && (
        <button className="btn shrink-0 text-red-600" title="移除此侧" onClick={onRemove}>
          ×
        </button>
      )}
    </div>
  );
}
