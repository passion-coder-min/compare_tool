// 单页主界面：2-4 个源（文件/目录/分支）动态增删，
// 四页签（目录对比 / 文本对比 / 十六进制对比 / Git 树），支持空白对比。
import { useEffect, useMemo, useState } from 'react';
import { DirCompareView, type UnifiedEntry } from './DirCompareView';
import { GitTreeView } from './GitTreeView';
import { SourceSelector } from './SourceSelector';
import { TextCompare } from '../text-compare/TextCompare';
import { HexCompare } from '../hex-compare/HexCompare';
import { api } from '../../lib/tauri';
import { basename, joinPath } from '../../lib/utils';
import { toast } from '../../stores/toast';
import { gitModeOf, MAX_SIDES, useCompare, type TabKind } from '../../stores/compare';

export function ComparePage() {
  const sources = useCompare((s) => s.sources);
  const setSource = useCompare((s) => s.setSource);
  const addSource = useCompare((s) => s.addSource);
  const removeSource = useCompare((s) => s.removeSource);
  const swapSources = useCompare((s) => s.swapSources);
  const activeTab = useCompare((s) => s.activeTab);
  const setActiveTab = useCompare((s) => s.setActiveTab);
  const textSession = useCompare((s) => s.textSession);
  const openText = useCompare((s) => s.openText);

  const [refreshKey, setRefreshKey] = useState(0);

  const n = sources.length;
  const anyEmpty = sources.some((s) => (s.kind === 'dir' || s.kind === 'file') && s.path === '');
  const bothSet = n >= 2 && !anyEmpty;
  const allFiles = n >= 2 && sources.every((s) => s.kind === 'file');
  const allDirs = n >= 2 && sources.every((s) => s.kind === 'dir');
  const gitMode = gitModeOf(sources);
  const anyGit = sources.some((s) => s.kind === 'git');
  const invalidMix = bothSet && !allFiles && !allDirs && !gitMode;

  // 空白对比：无源文件，双栏粘贴/输入实时对比
  const openBlank = () =>
    openText({
      sides: [
        { content: '', label: '左侧（粘贴/输入）' },
        { content: '', label: '右侧（粘贴/输入）' },
      ],
      editableLast: true,
      scratch: true,
      title: '空白对比',
    });

  // 文件源直接对比时派生文本会话
  const effectiveTextSession = useMemo(() => {
    if (textSession) return textSession;
    if (allFiles) {
      return {
        sides: sources.map((s) => ({
          path: (s as { path: string }).path,
          label: basename((s as { path: string }).path),
        })),
        editableLast: true,
        title: '文件对比',
      };
    }
    return null;
  }, [textSession, allFiles, sources]);

  // 页签可用性
  const tabs: { kind: TabKind; label: string; enabled: boolean }[] = [
    { kind: 'dirs', label: '📁 目录对比', enabled: allDirs || !!gitMode },
    { kind: 'text', label: '📄 文本对比', enabled: allFiles || !!textSession },
    { kind: 'hex', label: '🔢 十六进制对比', enabled: allFiles },
    {
      kind: 'tree',
      label: gitMode ? `🌳 Git 树（${gitMode.base} ⇄ ${gitMode.target}）` : '🌳 Git 树',
      enabled: !!gitMode,
    },
  ];

  // 页签失效时回退；文件源时自动进入文本对比
  useEffect(() => {
    const t = tabs.find((x) => x.kind === activeTab);
    if (activeTab !== 'dirs' && (!t || !t.enabled)) setActiveTab('dirs');
    if (activeTab === 'dirs' && allFiles && !textSession) setActiveTab('text');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allDirs, allFiles, gitMode, textSession, activeTab]);

  const openFile = async (e: UnifiedEntry) => {
    if (allDirs) {
      openText({
        sides: sources.map((s) => ({
          path: joinPath((s as { path: string }).path, e.relPath),
          label: e.relPath,
        })),
        editableLast: true,
        title: basename(e.relPath),
      });
    } else if (gitMode) {
      try {
        const l =
          e.gitStatus === 'A'
            ? ''
            : await api.gitFileContent(gitMode.repo, gitMode.base, e.oldPath ?? e.relPath);
        const r =
          e.gitStatus === 'D' ? '' : await api.gitFileContent(gitMode.repo, gitMode.target, e.relPath);
        openText({
          sides: [
            { content: l, label: `${gitMode.base}:${e.relPath}` },
            { content: r, label: `${gitMode.target}:${e.relPath}` },
          ],
          editableLast: false,
          title: `${e.relPath}（${gitMode.base}…${gitMode.target}）`,
        });
      } catch (err) {
        toast.error(String(err));
      }
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* 源选择 */}
      <header className="px-3 py-2 border-b bg-neutral-50 space-y-1.5 shrink-0">
        <div className="flex items-center gap-2 flex-wrap">
          {sources.map((s, i) => (
            <SourceSelector
              key={i}
              index={i}
              total={n}
              source={s}
              onChange={(ns) => setSource(i, ns)}
              onRemove={() => removeSource(i)}
            />
          ))}
          {n === 2 && (
            <button className="btn shrink-0" title="交换左右" onClick={swapSources} disabled={!bothSet}>
              ⇄
            </button>
          )}
          {n < MAX_SIDES && !anyGit && (
            <button
              className="btn shrink-0"
              title={`增加一路对比源（最多 ${MAX_SIDES} 路）`}
              onClick={addSource}
            >
              ＋
            </button>
          )}
          <button className="btn shrink-0" onClick={openBlank} title="不选文件，直接粘贴/输入内容对比">
            📝 空白对比
          </button>
          <button className="btn shrink-0" onClick={() => setRefreshKey((k) => k + 1)} disabled={!bothSet}>
            ⟳ 刷新
          </button>
        </div>
        {gitMode && (
          <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
            🌿 分支对比模式：{gitMode.base}...{gitMode.target}（共同祖先以来 {gitMode.target} 的改动），
            cherry-pick 会应用到当前检出分支
          </div>
        )}
        {n > 2 && allDirs && (
          <div className="text-xs text-neutral-600 bg-neutral-100 border border-neutral-200 rounded px-2 py-1">
            🔀 {n} 路目录对比：名称栏按「相等类」字母标记（同字母 = 内容相同）；
            多路模式为只读，文件操作请使用两路模式
          </div>
        )}
        {allFiles && (
          <div className="text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded px-2 py-1">
            📄 文件对比模式：{n} 路并排；末侧可双击编辑，Ctrl+S 保存；可在「十六进制对比」页签查看字节级差异
          </div>
        )}
      </header>

      {/* 页签 */}
      <div className="flex items-center gap-1 px-3 pt-2 border-b shrink-0 text-sm bg-white">
        {tabs.map((t) => (
          <button
            key={t.kind}
            className={
              'px-3 py-1.5 border-x border-t rounded-t truncate max-w-72 ' +
              (activeTab === t.kind
                ? 'bg-white border-neutral-300'
                : t.enabled
                  ? 'text-neutral-500 border-transparent hover:bg-neutral-50'
                  : 'text-neutral-300 border-transparent cursor-not-allowed')
            }
            onClick={() => t.enabled && setActiveTab(t.kind)}
            title={t.enabled ? undefined : '当前源组合不支持此对比方式'}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* 主体 */}
      <div className="flex-1 min-h-0 bg-white">
        {!bothSet && !textSession && (
          <div className="h-full flex flex-col items-center justify-center text-neutral-400 gap-3">
            <div className="text-5xl">⇄</div>
            <div className="text-sm">
              在上方为各侧选择 <b>📄 文件</b>（直接文本/Hex 对比）、<b>📁 目录</b>（目录对比）或{' '}
              <b>🌿 分支</b>（git 对比）
            </div>
            <div className="text-xs">可用 ＋ 增加到最多 {MAX_SIDES} 路同时对比</div>
            <button className="btn-primary" onClick={openBlank}>
              📝 或从空白对比开始（粘贴两侧内容）
            </button>
          </div>
        )}
        {invalidMix && (
          <div className="h-full flex flex-col items-center justify-center text-neutral-400 gap-2">
            <div className="text-4xl">⚠️</div>
            <div className="text-sm">各侧源类型不一致</div>
            <div className="text-xs">请各侧统一为文件、目录，或两侧均为同一仓库的分支</div>
          </div>
        )}
        {(allDirs || gitMode) && activeTab === 'dirs' && (
          <DirCompareView
            key={`dirs-${refreshKey}-${sources.map((s) => JSON.stringify(s)).join('|')}`}
            sources={sources}
            onOpenFile={openFile}
          />
        )}
        {activeTab === 'text' && effectiveTextSession && (
          <TextCompare
            key={`text-${refreshKey}-${JSON.stringify(effectiveTextSession.sides)}`}
            session={effectiveTextSession}
          />
        )}
        {activeTab === 'hex' && allFiles && (
          <HexCompare
            key={`hex-${refreshKey}-${sources.map((s) => (s as { path: string }).path).join('|')}`}
            paths={sources.map((s) => (s as { path: string }).path)}
          />
        )}
        {gitMode && activeTab === 'tree' && (
          <GitTreeView
            key={`tree-${refreshKey}-${gitMode.repo}-${gitMode.base}-${gitMode.target}`}
            repo={gitMode.repo}
            base={gitMode.base}
            target={gitMode.target}
            refreshKey={refreshKey}
          />
        )}
      </div>
    </div>
  );
}
