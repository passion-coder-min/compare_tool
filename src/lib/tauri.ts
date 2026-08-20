// 类型化的 Tauri invoke 封装。注意：JS 侧 camelCase 键自动映射 Rust snake_case 参数。
import { invoke } from '@tauri-apps/api/core';
import type {
  CherryPickResult,
  CommitInfo,
  DiffResult,
  DirEntryDiff,
  FileDiffEntry,
  GitDirEntry,
  GraphData,
  HexOverview,
  HexOverviewMulti,
  HexRow,
  HexRowMulti,
  MultiDirEntry,
  MultiTextDiff,
  RepoInfo,
  StatusEntry,
  TextFile,
} from './types';

export const api = {
  // 文本对比
  compareText(leftPath: string, rightPath: string): Promise<DiffResult> {
    return invoke('compare_text', { leftPath, rightPath });
  },
  compareTextContent(left: string, right: string): Promise<DiffResult> {
    return invoke('compare_text_content', { left, right });
  },
  compareTextMulti(texts: string[]): Promise<MultiTextDiff> {
    return invoke('compare_text_multi', { texts });
  },
  readTextFile(path: string): Promise<TextFile> {
    return invoke('read_text_file', { path });
  },
  saveFile(path: string, content: string): Promise<void> {
    return invoke('save_file', { path, content });
  },
  pathKind(path: string): Promise<'file' | 'dir' | 'missing'> {
    return invoke('path_kind', { path });
  },

  // 文件夹对比
  compareDirs(leftDir: string, rightDir: string, useHash: boolean): Promise<DirEntryDiff[]> {
    return invoke('compare_dirs', { leftDir, rightDir, useHash });
  },
  compareDirsMulti(dirs: string[], useHash: boolean): Promise<MultiDirEntry[]> {
    return invoke('compare_dirs_multi', { dirs, useHash });
  },
  copyPathAcross(srcPath: string, dstPath: string): Promise<void> {
    return invoke('copy_path_across', { srcPath, dstPath });
  },
  deletePath(path: string, isDir: boolean): Promise<void> {
    return invoke('delete_path', { path, isDir });
  },

  // 十六进制对比
  hexOverview(leftPath: string, rightPath: string): Promise<HexOverview> {
    return invoke('hex_overview', { leftPath, rightPath });
  },
  readHexWindow(
    leftPath: string,
    rightPath: string,
    startRow: number,
    rowCount: number,
  ): Promise<HexRow[]> {
    return invoke('read_hex_window', { leftPath, rightPath, startRow, rowCount });
  },
  hexOverviewMulti(paths: string[]): Promise<HexOverviewMulti> {
    return invoke('hex_overview_multi', { paths });
  },
  readHexWindowMulti(
    paths: string[],
    startRow: number,
    rowCount: number,
  ): Promise<HexRowMulti[]> {
    return invoke('read_hex_window_multi', { paths, startRow, rowCount });
  },

  // git
  gitOpenRepo(path: string): Promise<RepoInfo> {
    return invoke('git_open_repo', { path });
  },
  gitStatus(repo: string): Promise<StatusEntry[]> {
    return invoke('git_status', { repo });
  },
  gitDiffRefs(repo: string, baseRef: string, targetRef: string): Promise<FileDiffEntry[]> {
    return invoke('git_diff_refs', { repo, baseRef, targetRef });
  },
  gitDirDiff(repo: string, baseRef: string, targetRef: string): Promise<GitDirEntry[]> {
    return invoke('git_dir_diff', { repo, baseRef, targetRef });
  },
  gitGraph(repo: string, baseRef: string, targetRef: string): Promise<GraphData> {
    return invoke('git_graph', { repo, baseRef, targetRef });
  },
  gitFileContent(repo: string, gitRef: string, path: string): Promise<string> {
    return invoke('git_file_content', { repo, gitRef, path });
  },
  gitCommitsBetween(repo: string, baseRef: string, targetRef: string): Promise<CommitInfo[]> {
    return invoke('git_commits_between', { repo, baseRef, targetRef });
  },
  gitCherryPick(repo: string, shas: string[]): Promise<CherryPickResult> {
    return invoke('git_cherry_pick', { repo, shas });
  },
  gitStageFiles(repo: string, paths: string[]): Promise<void> {
    return invoke('git_stage_files', { repo, paths });
  },
  gitCherryPickContinue(repo: string, paths: string[]): Promise<string> {
    return invoke('git_cherry_pick_continue', { repo, paths });
  },
  gitCherryPickAbort(repo: string): Promise<void> {
    return invoke('git_cherry_pick_abort', { repo });
  },
};
