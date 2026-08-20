// 与 src-tauri 侧 DTO 一一对应的前端类型定义

// ---------- 文本对比 ----------

export interface InlineSpan {
  start: number;
  end: number;
}

export type LineKind = 'equal' | 'delete' | 'insert';

export interface DiffLine {
  text: string;
  kind: LineKind;
  number: number | null;
  inline: InlineSpan[];
}

export interface DiffRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

export interface DiffStats {
  removed: number;
  added: number;
  blocks: number;
}

export interface DiffResult {
  rows: DiffRow[];
  stats: DiffStats;
  eol: string;
}

export interface TextFile {
  content: string;
  eol: string;
}

// ---------- 文件夹对比 ----------

export type DirStatus =
  | 'only_left'
  | 'only_right'
  | 'same'
  | 'different'
  | 'left_newer'
  | 'right_newer'
  | 'error';

export interface DirEntryDiff {
  rel_path: string;
  is_dir: boolean;
  status: DirStatus;
  left_size: number | null;
  right_size: number | null;
  left_mtime: number | null;
  right_mtime: number | null;
  error: string | null;
}

// ---------- 十六进制对比 ----------

export interface HexRow {
  offset: number;
  left: number[] | null;
  right: number[] | null;
  left_diff: number[];
  right_diff: number[];
}

export interface HexOverview {
  left_size: number;
  right_size: number;
  first_diff: number | null;
  identical: boolean;
}

// ---------- git ----------

export interface RepoInfo {
  root: string;
  current_branch: string;
  branches: string[];
}

export interface FileDiffEntry {
  status: string;
  path: string;
  old_path: string | null;
}

export interface CommitInfo {
  sha: string;
  short: string;
  author: string;
  timestamp: number;
  message: string;
}

export interface StatusEntry {
  xy: string;
  path: string;
}

export interface ConflictFile {
  path: string;
}

export type CherryPickResult =
  | { type: 'success'; picked: string[] }
  | { type: 'dirty'; files: StatusEntry[] }
  | { type: 'conflict'; failed_sha: string; files: ConflictFile[] };

// ---------- git 树目录对比 / 提交图 ----------

export interface GitDirEntry {
  rel_path: string;
  status: string;
  old_path: string | null;
  left_size: number | null;
  right_size: number | null;
}

export interface GraphCommit {
  sha: string;
  short: string;
  author: string;
  timestamp: number;
  message: string;
  parents: string[];
  /** 0 = base 侧独有，1 = target 侧独有 */
  lane: number;
}

export interface GraphData {
  /** 按时间新→旧排列 */
  commits: GraphCommit[];
  merge_base: string | null;
  /** 已在当前分支中（patch 等价）的 target 侧提交 */
  already_in_current: string[];
  current_branch: string;
}

// ---------- 多路对比 ----------

export interface MultiStats {
  blocks: number;
  changed: number;
}

/** 每行为 N 个槽位，None 表示该侧此处无行 */
export type MultiTextDiff = {
  rows: (DiffLine | null)[][];
  sides: number;
  eols: string[];
  stats: MultiStats;
};

export interface MultiSideMeta {
  present: boolean;
  size: number | null;
  mtime_ms: number | null;
}

export interface MultiDirEntry {
  rel_path: string;
  is_dir: boolean;
  sides: MultiSideMeta[];
  /** 每侧内容相等类索引（相同=内容相同）；不存在侧为 4294967295 */
  class: number[];
  all_equal: boolean;
  error: string | null;
}

export interface HexRowMulti {
  offset: number;
  sides: (number[] | null)[];
  /** 各侧不全部相同的字节位置（行内索引） */
  diff: number[];
}

export interface HexOverviewMulti {
  sizes: number[];
  first_diff: number | null;
  identical: boolean;
}
