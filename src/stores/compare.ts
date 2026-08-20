// 单页多路对比状态：2-4 个源 + 页签 + 文本对比会话
import { create } from 'zustand';

export type SourceSpec =
  | { kind: 'dir'; path: string } // 目录
  | { kind: 'file'; path: string } // 单个文件（直接文本/Hex 对比）
  | { kind: 'git'; repo: string; ref: string };

export interface FileSide {
  /** 文件路径（磁盘） */
  path?: string;
  /** 直接给定内容（git 引用等） */
  content?: string;
  label: string;
}

export interface TextSession {
  sides: FileSide[];
  /** 最后一侧是否可编辑（磁盘文件时） */
  editableLast: boolean;
  title: string;
  /** 空白对比：无源文件，全部侧可直接粘贴/输入，实时对比 */
  scratch?: boolean;
}

export type TabKind = 'dirs' | 'text' | 'hex' | 'tree';

export const MAX_SIDES = 4;

interface CompareState {
  sources: SourceSpec[];
  activeTab: TabKind;
  textSession: TextSession | null;
  setSource: (i: number, s: SourceSpec | null) => void;
  addSource: () => void;
  removeSource: (i: number) => void;
  swapSources: () => void;
  setActiveTab: (t: TabKind) => void;
  openText: (session: TextSession) => void;
}

export const useCompare = create<CompareState>((set) => ({
  sources: [
    { kind: 'dir', path: '' },
    { kind: 'dir', path: '' },
  ],
  activeTab: 'dirs',
  textSession: null,
  setSource: (i, s) =>
    set((st) => {
      if (s === null) {
        // 清空：多路时移除该侧，两路时重置为空占位
        if (st.sources.length > 2) {
          return { sources: st.sources.filter((_, k) => k !== i), textSession: null };
        }
        const sources = [...st.sources];
        sources[i] = { kind: 'dir', path: '' };
        return { sources, textSession: null };
      }
      // 越界时补齐占位（演示模式等场景）
      const sources = [...st.sources];
      while (sources.length <= i) sources.push({ kind: 'dir', path: '' });
      sources[i] = s;
      return { sources, textSession: null };
    }),
  addSource: () =>
    set((st) =>
      st.sources.length < MAX_SIDES && st.sources.every((s) => s.kind === 'dir')
        ? { sources: [...st.sources, { kind: 'dir', path: '' }], textSession: null }
        : {},
    ),
  removeSource: (i) =>
    set((st) =>
      st.sources.length > 2
        ? { sources: st.sources.filter((_, k) => k !== i), textSession: null }
        : {},
    ),
  swapSources: () =>
    set((st) =>
      st.sources.length === 2
        ? { sources: [st.sources[1], st.sources[0]], textSession: null }
        : {},
    ),
  setActiveTab: (t) => set({ activeTab: t }),
  openText: (session) => set({ textSession: session, activeTab: 'text' }),
}));

/** git 双分支模式是否成立（git 对比固定两路） */
export function gitModeOf(sources: SourceSpec[]): { repo: string; base: string; target: string } | null {
  if (
    sources.length === 2 &&
    sources[0].kind === 'git' &&
    sources[1].kind === 'git' &&
    sources[0].repo === sources[1].repo
  ) {
    return { repo: sources[0].repo, base: sources[0].ref, target: sources[1].ref };
  }
  return null;
}
