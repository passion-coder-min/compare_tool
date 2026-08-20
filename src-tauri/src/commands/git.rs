//! Git 集成：通过系统 git CLI 实现。
//! 所有引用/路径作为独立参数传递（不经 shell），并校验引用格式，
//! 防止以 "-" 开头的参数被 git 解释为选项。

use std::process::Command;

use serde::Serialize;

use super::CmdResult;

fn run_git_raw(repo: &str, args: &[&str]) -> std::io::Result<std::process::Output> {
    Command::new("git")
        .current_dir(repo)
        // 防止任何子命令拉起交互式编辑器卡死应用
        .env("GIT_EDITOR", "true")
        .env("GIT_PAGER", "cat")
        .args(["-c", "core.quotepath=false", "-c", "color.ui=never"])
        .args(args)
        .output()
}

fn run_git(repo: &str, args: &[&str]) -> CmdResult<String> {
    let out = run_git_raw(repo, args).map_err(|e| format!("无法启动 git: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git {} 失败: {}",
            args.first().unwrap_or(&""),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// 允许的引用字符：字母数字 _ . / - :（":2" 用于冲突阶段的 index 引用）
fn valid_ref(r: &str) -> CmdResult<()> {
    let ok = !r.is_empty()
        && !r.starts_with('-')
        && r.chars().all(|c| {
            matches!(c, 'A'..='Z' | 'a'..='z' | '0'..='9' | '_' | '.' | '/' | '-' | ':')
        });
    if ok {
        Ok(())
    } else {
        Err(format!("非法的 git 引用: {r:?}"))
    }
}

// ---------- DTO ----------

#[derive(Serialize, Clone, Debug)]
pub struct RepoInfo {
    pub root: String,
    pub current_branch: String,
    pub branches: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct FileDiffEntry {
    /// 首字母：M 修改 / A 新增 / D 删除 / R 重命名 / C 复制 / T 类型变更
    pub status: String,
    pub path: String,
    pub old_path: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct CommitInfo {
    pub sha: String,
    pub short: String,
    pub author: String,
    pub timestamp: i64,
    pub message: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct StatusEntry {
    /// porcelain 状态码，如 " M"、UU、AA
    pub xy: String,
    pub path: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct ConflictFile {
    pub path: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CherryPickResult {
    /// 全部成功
    Success { picked: Vec<String> },
    /// 工作区不干净，先提交或暂存
    Dirty { files: Vec<StatusEntry> },
    /// 冲突：cherry-pick 停在 failed_sha，需解决 files 中的冲突后继续
    Conflict {
        failed_sha: String,
        files: Vec<ConflictFile>,
    },
}

// ---------- 基础查询 ----------

#[tauri::command]
pub async fn git_open_repo(path: String) -> CmdResult<RepoInfo> {
    let root = run_git(&path, &["rev-parse", "--show-toplevel"])?
        .trim()
        .to_string();
    if root.is_empty() {
        return Err(format!("{path} 不是 git 仓库"));
    }
    let current_branch = run_git(&root, &["rev-parse", "--abbrev-ref", "HEAD"])?
        .trim()
        .to_string();
    let branches = run_git(
        &root,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    )?
    .lines()
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
    .collect();
    Ok(RepoInfo {
        root,
        current_branch,
        branches,
    })
}

fn parse_porcelain(out: &str) -> Vec<StatusEntry> {
    // -z 格式：每个条目为 NUL 结尾的 `XY PATH`（XY 恒为 2 字符），
    // 重命名/复制条目后跟一个独立的来源路径 token
    let toks: Vec<&str> = out.split('\0').collect();
    let mut v = Vec::new();
    let mut i = 0;
    while i < toks.len() {
        let entry = toks[i];
        i += 1;
        if entry.is_empty() {
            continue;
        }
        let bytes = entry.as_bytes();
        if bytes.len() < 3 || bytes[2] != b' ' {
            // 非条目 token（如重命名来源路径），跳过
            continue;
        }
        let xy = &entry[..2];
        v.push(StatusEntry {
            xy: xy.to_string(),
            path: entry[3..].to_string(),
        });
        if xy.starts_with('R') || xy.starts_with('C') {
            i += 1; // 跳过来源路径 token
        }
    }
    v
}

fn is_conflict_xy(xy: &str) -> bool {
    xy.contains('U') || xy.starts_with("AA") || xy.starts_with("DD")
}

#[tauri::command]
pub async fn git_status(repo: String) -> CmdResult<Vec<StatusEntry>> {
    let out = run_git(&repo, &["status", "--porcelain", "-z"])?;
    Ok(parse_porcelain(&out))
}

/// 分支差异：base...target（自共同祖先以来 target 的改动），
/// 与 cherry-pick "摘取 target 提交" 的语义一致。
#[tauri::command]
pub async fn git_diff_refs(
    repo: String,
    base_ref: String,
    target_ref: String,
) -> CmdResult<Vec<FileDiffEntry>> {
    valid_ref(&base_ref)?;
    valid_ref(&target_ref)?;
    diff_refs_entries(&repo, &base_ref, &target_ref)
}

fn diff_refs_entries(repo: &str, base_ref: &str, target_ref: &str) -> CmdResult<Vec<FileDiffEntry>> {
    let out = run_git(
        repo,
        &[
            "diff",
            "--name-status",
            "-z",
            &format!("{base_ref}...{target_ref}"),
        ],
    )?;
    let toks: Vec<&str> = out.split('\0').collect();
    let mut v = Vec::new();
    let mut i = 0;
    while i < toks.len() && !toks[i].is_empty() {
        let st = toks[i];
        i += 1;
        if i >= toks.len() {
            break;
        }
        let path = toks[i];
        i += 1;
        let mut old_path = None;
        if st.starts_with('R') || st.starts_with('C') {
            if i < toks.len() {
                old_path = Some(toks[i].to_string());
                i += 1;
            }
        }
        v.push(FileDiffEntry {
            status: st.chars().next().unwrap_or('M').to_string(),
            path: path.to_string(),
            old_path,
        });
    }
    Ok(v)
}

/// 某个引用下的文件清单及大小（一次 ls-tree 调用）
fn ls_tree_sizes(repo: &str, git_ref: &str) -> CmdResult<std::collections::HashMap<String, u64>> {
    valid_ref(git_ref)?;
    let out = run_git(repo, &["ls-tree", "-r", "-l", "-z", git_ref])?;
    let mut map = std::collections::HashMap::new();
    for entry in out.split('\0') {
        if entry.is_empty() {
            continue;
        }
        // -z 条目格式：`<mode> <type> <sha> <size>\t<path>`（size 对 blob 为数字）
        let mut parts = entry.splitn(2, '\t');
        let meta = parts.next().unwrap_or("");
        let path = match parts.next() {
            Some(p) if !p.is_empty() => p,
            _ => continue,
        };
        let size = meta.split_whitespace().nth(3).unwrap_or("-");
        if let Ok(n) = size.parse::<u64>() {
            map.insert(path.to_string(), n);
        }
    }
    Ok(map)
}

#[derive(Serialize, Clone, Debug)]
pub struct GitDirEntry {
    pub rel_path: String,
    /// M 修改 / A 新增 / D 删除 / R 重命名 / C 复制 / T 类型变更
    pub status: String,
    pub old_path: Option<String>,
    pub left_size: Option<u64>,
    pub right_size: Option<u64>,
}

/// 分支树目录对比：两个引用的文件差异 + 各侧文件大小，
/// 供统一目录对比网格以"git 模式"呈现。
#[tauri::command]
pub async fn git_dir_diff(
    repo: String,
    base_ref: String,
    target_ref: String,
) -> CmdResult<Vec<GitDirEntry>> {
    valid_ref(&base_ref)?;
    valid_ref(&target_ref)?;
    let left_sizes = ls_tree_sizes(&repo, &base_ref)?;
    let right_sizes = ls_tree_sizes(&repo, &target_ref)?;
    let diffs = diff_refs_entries(&repo, &base_ref, &target_ref)?;
    Ok(diffs
        .into_iter()
        .map(|d| {
            let left_size = d
                .old_path
                .as_ref()
                .and_then(|p| left_sizes.get(p))
                .or_else(|| left_sizes.get(&d.path))
                .copied();
            GitDirEntry {
                rel_path: d.path.clone(),
                left_size,
                right_size: right_sizes.get(&d.path).copied(),
                status: d.status,
                old_path: d.old_path,
            }
        })
        .collect())
}

// ---------- 提交图 ----------

#[derive(Serialize, Clone, Debug)]
pub struct GraphCommit {
    pub sha: String,
    pub short: String,
    pub author: String,
    pub timestamp: i64,
    pub message: String,
    pub parents: Vec<String>,
    /// 0 = base 侧独有，1 = target 侧独有
    pub lane: u8,
}

#[derive(Serialize, Clone, Debug)]
pub struct GraphData {
    /// 按时间新→旧排列（date-order）
    pub commits: Vec<GraphCommit>,
    /// 共同祖先（分叉点）
    pub merge_base: Option<String>,
    /// 已在当前分支中（patch 等价）的 target 侧提交 sha
    pub already_in_current: Vec<String>,
    pub current_branch: String,
}

/// 分支树对比数据：两车道提交图 + cherry 标记，用于 Git 树视图。
#[tauri::command]
pub async fn git_graph(
    repo: String,
    base_ref: String,
    target_ref: String,
) -> CmdResult<GraphData> {
    valid_ref(&base_ref)?;
    valid_ref(&target_ref)?;

    let current_branch = run_git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])?
        .trim()
        .to_string();

    // rev-list 的排除参数必须独立传参，不能拼进同一个字符串
    let rev_list = |a: &str, b: &str| -> CmdResult<Vec<String>> {
        Ok(run_git(&repo, &["rev-list", a, &format!("^{b}")])?
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect())
    };
    let base_only = rev_list(&base_ref, &target_ref)?;
    let target_only = rev_list(&target_ref, &base_ref)?;
    let base_set: std::collections::HashSet<&str> =
        base_only.iter().map(|s| s.as_str()).collect();
    let target_set: std::collections::HashSet<&str> =
        target_only.iter().map(|s| s.as_str()).collect();

    let merge_base = run_git(&repo, &["merge-base", &base_ref, &target_ref])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    // 对称差提交（两车道），date-order 新→旧
    let out = run_git(
        &repo,
        &[
            "log",
            "--date-order",
            "--format=%H%x1f%h%x1f%an%x1f%at%x1f%s%x1f%P%x1e",
            &format!("{base_ref}...{target_ref}"),
        ],
    )?;
    let mut commits = Vec::new();
    for rec in out.split('\x1e') {
        let rec = rec.trim_start_matches(['\n', '\r']);
        if rec.trim().is_empty() {
            continue;
        }
        let parts: Vec<&str> = rec.splitn(6, '\x1f').collect();
        if parts.len() < 6 {
            continue;
        }
        let sha = parts[0].to_string();
        let lane = if target_set.contains(sha.as_str()) {
            1
        } else if base_set.contains(sha.as_str()) {
            0
        } else {
            continue;
        };
        commits.push(GraphCommit {
            parents: parts[5]
                .split_whitespace()
                .map(|s| s.to_string())
                .collect(),
            sha,
            short: parts[1].to_string(),
            author: parts[2].to_string(),
            timestamp: parts[3].parse().unwrap_or(0),
            message: parts[4].trim_end().to_string(),
            lane,
        });
    }

    // git cherry <当前分支> <target>：'-' 开头表示 patch 等价已存在
    let mut already_in_current = Vec::new();
    if current_branch != target_ref {
        if let Ok(cherry) = run_git(&repo, &["cherry", &current_branch, &target_ref]) {
            for line in cherry.lines() {
                if let Some(sha) = line.strip_prefix('-') {
                    already_in_current.push(sha.trim().to_string());
                }
            }
        }
    } else {
        // 目标即当前分支：全部视为已在当前分支
        already_in_current.extend(target_only.iter().cloned());
    }

    Ok(GraphData {
        commits,
        merge_base,
        already_in_current,
        current_branch,
    })
}

/// 读取某个引用下的文件内容（分支名 / HEAD / :2 等 index 阶段引用均可）
#[tauri::command]
pub async fn git_file_content(repo: String, git_ref: String, path: String) -> CmdResult<String> {
    valid_ref(&git_ref)?;
    if path.is_empty() {
        return Err("文件路径为空".into());
    }
    let spec = format!("{git_ref}:{path}");
    run_git(&repo, &["show", &spec])
}

/// base..target 之间的提交（target 有而 base 没有的）
#[tauri::command]
pub async fn git_commits_between(
    repo: String,
    base_ref: String,
    target_ref: String,
) -> CmdResult<Vec<CommitInfo>> {
    valid_ref(&base_ref)?;
    valid_ref(&target_ref)?;
    let out = run_git(
        &repo,
        &[
            "log",
            "--format=%H%x1f%h%x1f%an%x1f%at%x1f%s%x1e",
            &format!("{base_ref}..{target_ref}"),
        ],
    )?;
    let mut v = Vec::new();
    for rec in out.split('\x1e') {
        let rec = rec.trim_start_matches(['\n', '\r']);
        if rec.trim().is_empty() {
            continue;
        }
        let parts: Vec<&str> = rec.splitn(5, '\x1f').collect();
        if parts.len() < 5 {
            continue;
        }
        v.push(CommitInfo {
            sha: parts[0].to_string(),
            short: parts[1].to_string(),
            author: parts[2].to_string(),
            timestamp: parts[3].parse().unwrap_or(0),
            message: parts[4].trim_end().to_string(),
        });
    }
    Ok(v)
}

// ---------- cherry-pick 流程 ----------

/// 依次 cherry-pick 选中的提交（应用到当前检出分支）。
/// 工作区不干净时拒绝执行；遇到冲突立即停止并返回冲突文件列表。
#[tauri::command]
pub async fn git_cherry_pick(repo: String, shas: Vec<String>) -> CmdResult<CherryPickResult> {
    if shas.is_empty() {
        return Err("未选择任何提交".into());
    }
    let dirty = parse_porcelain(&run_git(&repo, &["status", "--porcelain", "-z"])?);
    if !dirty.is_empty() {
        return Ok(CherryPickResult::Dirty { files: dirty });
    }

    let mut picked = Vec::new();
    for sha in &shas {
        valid_ref(sha)?;
        let out = run_git_raw(&repo, &["cherry-pick", sha])
            .map_err(|e| format!("无法启动 git: {e}"))?;
        if out.status.success() {
            picked.push(sha.clone());
            continue;
        }
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let st = parse_porcelain(&run_git(&repo, &["status", "--porcelain", "-z"])?);
        let conflicts: Vec<ConflictFile> = st
            .iter()
            .filter(|e| is_conflict_xy(&e.xy))
            .map(|e| ConflictFile {
                path: e.path.clone(),
            })
            .collect();
        if !conflicts.is_empty() {
            return Ok(CherryPickResult::Conflict {
                failed_sha: sha.clone(),
                files: conflicts,
            });
        }
        // 非冲突失败：尝试中止残留状态后报错
        let _ = run_git(&repo, &["cherry-pick", "--abort"]);
        return Err(format!("cherry-pick {sha} 失败: {stderr}"));
    }
    Ok(CherryPickResult::Success { picked })
}

/// 暂存文件（冲突解决后标记）
#[tauri::command]
pub async fn git_stage_files(repo: String, paths: Vec<String>) -> CmdResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args: Vec<String> = vec!["add".into(), "--".into()];
    args.extend(paths);
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run_git(&repo, &refs).map(|_| ())
}

/// 冲突解决后继续 cherry-pick。paths 为刚解决完的冲突文件（先 git add）。
/// 返回新提交的短 SHA。
#[tauri::command]
pub async fn git_cherry_pick_continue(repo: String, paths: Vec<String>) -> CmdResult<String> {
    git_stage_files(repo.clone(), paths).await?;
    let st = parse_porcelain(&run_git(&repo, &["status", "--porcelain", "-z"])?);
    let unresolved: Vec<&str> = st
        .iter()
        .filter(|e| is_conflict_xy(&e.xy))
        .map(|e| e.path.as_str())
        .collect();
    if !unresolved.is_empty() {
        return Err(format!("仍有未解决的冲突: {}", unresolved.join(", ")));
    }
    run_git(&repo, &["cherry-pick", "--continue"])?;
    run_git(&repo, &["rev-parse", "--short", "HEAD"]).map(|s| s.trim().to_string())
}

/// 放弃进行中的 cherry-pick，回到操作前状态
#[tauri::command]
pub async fn git_cherry_pick_abort(repo: String) -> CmdResult<()> {
    run_git(&repo, &["cherry-pick", "--abort"]).map(|_| ())
}

// ---------- 测试（依赖系统 git，在临时仓库上端到端验证） ----------

#[cfg(test)]
mod tests {
    use super::*;

    /// 创建测试仓库：main 上两个提交，feature 分支两个提交
    fn fixture_repo() -> (tempfile::TempDir, String) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_string_lossy().into_owned();
        let cfg = [
            "-c",
            "user.email=t@t",
            "-c",
            "user.name=t",
            "-c",
            "commit.gpgsign=false",
        ];
        run_git(&root, &["init", "-b", "main"]).unwrap();
        std::fs::write(tmp.path().join("file.txt"), "line1\nline2\nline3\n").unwrap();
        run_git(&root, &[cfg[0], cfg[1], cfg[2], cfg[3], cfg[4], cfg[5], "add", "."]).unwrap();
        run_git(
            &root,
            &[cfg[0], cfg[1], cfg[2], cfg[3], cfg[4], cfg[5], "commit", "-m", "c1 base"],
        )
        .unwrap();
        run_git(&root, &["checkout", "-b", "feature"]).unwrap();
        std::fs::write(tmp.path().join("added.txt"), "new file\n").unwrap();
        run_git(&root, &[cfg[0], cfg[1], cfg[2], cfg[3], cfg[4], cfg[5], "add", "."]).unwrap();
        run_git(
            &root,
            &[cfg[0], cfg[1], cfg[2], cfg[3], cfg[4], cfg[5], "commit", "-m", "f1 add file"],
        )
        .unwrap();
        std::fs::write(tmp.path().join("file.txt"), "line1\nline2-feature\nline3\n").unwrap();
        run_git(&root, &[cfg[0], cfg[1], cfg[2], cfg[3], cfg[4], cfg[5], "add", "."]).unwrap();
        run_git(
            &root,
            &[cfg[0], cfg[1], cfg[2], cfg[3], cfg[4], cfg[5], "commit", "-m", "f2 modify line"],
        )
        .unwrap();
        run_git(&root, &["checkout", "main"]).unwrap();
        (tmp, root)
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Runtime::new().unwrap()
    }

    #[test]
    fn open_repo_lists_branches() {
        let (_tmp, root) = fixture_repo();
        let info = rt().block_on(git_open_repo(root.clone())).unwrap();
        assert_eq!(info.current_branch, "main");
        assert!(info.branches.contains(&"main".to_string()));
        assert!(info.branches.contains(&"feature".to_string()));
        assert_eq!(info.root, root);
    }

    #[test]
    fn diff_refs_and_commits() {
        let (_tmp, root) = fixture_repo();
        let diffs = rt()
            .block_on(git_diff_refs(root.clone(), "main".into(), "feature".into()))
            .unwrap();
        let paths: Vec<&str> = diffs.iter().map(|d| d.path.as_str()).collect();
        assert!(paths.contains(&"file.txt"));
        assert!(paths.contains(&"added.txt"));
        assert_eq!(diffs.iter().find(|d| d.path == "added.txt").unwrap().status, "A");

        let commits = rt()
            .block_on(git_commits_between(root, "main".into(), "feature".into()))
            .unwrap();
        assert_eq!(commits.len(), 2);
        assert!(commits[0].message.contains("f2")); // 新提交在前
        assert!(!commits[0].sha.is_empty());
    }

    #[test]
    fn file_content_by_ref() {
        let (_tmp, root) = fixture_repo();
        let main = rt()
            .block_on(git_file_content(root.clone(), "main".into(), "file.txt".into()))
            .unwrap();
        let feat = rt()
            .block_on(git_file_content(root, "feature".into(), "file.txt".into()))
            .unwrap();
        assert!(main.contains("line2\n"));
        assert!(feat.contains("line2-feature"));
    }

    #[test]
    fn invalid_ref_rejected() {
        assert!(valid_ref("--exec").is_err());
        assert!(valid_ref("").is_err());
        assert!(valid_ref("main").is_ok());
        assert!(valid_ref("HEAD").is_ok());
        assert!(valid_ref(":2").is_ok());
        assert!(valid_ref("origin/main").is_ok());
    }

    #[test]
    fn cherry_pick_success_path() {
        let (_tmp, root) = fixture_repo();
        // f1（新增文件）与 main 无冲突，可干净摘取
        let commits = rt()
            .block_on(git_commits_between(root.clone(), "main".into(), "feature".into()))
            .unwrap();
        let f1 = commits.iter().rev().find(|c| c.message.contains("f1")).unwrap();
        let res = rt()
            .block_on(git_cherry_pick(root.clone(), vec![f1.sha.clone()]))
            .unwrap();
        match res {
            CherryPickResult::Success { picked } => {
                assert_eq!(picked, vec![f1.sha.clone()]);
            }
            other => panic!("期望成功，实际: {other:?}"),
        }
        assert!(std::path::Path::new(&root).join("added.txt").exists());
    }

    #[test]
    fn cherry_pick_conflict_detected() {
        let (_tmp, root) = fixture_repo();
        // main 修改同一行制造冲突
        std::fs::write(
            std::path::Path::new(&root).join("file.txt"),
            "line1\nline2-main\nline3\n",
        )
        .unwrap();
        run_git(&root, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-am", "m2"])
            .unwrap();
        let commits = rt()
            .block_on(git_commits_between(root.clone(), "main".into(), "feature".into()))
            .unwrap();
        let f2 = commits.iter().find(|c| c.message.contains("f2")).unwrap();
        let res = rt()
            .block_on(git_cherry_pick(root.clone(), vec![f2.sha.clone()]))
            .unwrap();
        match res {
            CherryPickResult::Conflict { failed_sha, files } => {
                assert_eq!(failed_sha, f2.sha);
                assert_eq!(files.len(), 1);
                assert_eq!(files[0].path, "file.txt");
            }
            other => panic!("期望冲突，实际: {other:?}"),
        }
        // 工作区应带有冲突标记
        let content = std::fs::read_to_string(std::path::Path::new(&root).join("file.txt")).unwrap();
        assert!(content.contains("<<<<<<<"));
        // 中止后恢复干净
        rt().block_on(git_cherry_pick_abort(root.clone())).unwrap();
        let st = rt().block_on(git_status(root)).unwrap();
        assert!(st.is_empty());
    }

    #[test]
    fn cherry_pick_conflict_resolve_and_continue() {
        let (_tmp, root) = fixture_repo();
        std::fs::write(
            std::path::Path::new(&root).join("file.txt"),
            "line1\nline2-main\nline3\n",
        )
        .unwrap();
        run_git(&root, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-am", "m2"])
            .unwrap();
        let commits = rt()
            .block_on(git_commits_between(root.clone(), "main".into(), "feature".into()))
            .unwrap();
        let f2 = commits.iter().find(|c| c.message.contains("f2")).unwrap();
        let res = rt()
            .block_on(git_cherry_pick(root.clone(), vec![f2.sha.clone()]))
            .unwrap();
        assert!(matches!(res, CherryPickResult::Conflict { .. }));

        // 手动解决冲突：直接写入最终内容
        std::fs::write(std::path::Path::new(&root).join("file.txt"), "line1\nline2-resolved\nline3\n").unwrap();
        let short = rt()
            .block_on(git_cherry_pick_continue(root, vec!["file.txt".into()]))
            .unwrap();
        assert!(!short.is_empty());
    }

    #[test]
    fn cherry_pick_dirty_rejected() {
        let (_tmp, root) = fixture_repo();
        std::fs::write(std::path::Path::new(&root).join("dirty.txt"), "x").unwrap();
        let res = rt()
            .block_on(git_cherry_pick(root.clone(), vec!["HEAD".into()]))
            .unwrap();
        assert!(matches!(res, CherryPickResult::Dirty { .. }));
    }

    #[test]
    fn dir_diff_includes_sizes() {
        let (_tmp, root) = fixture_repo();
        let entries = rt()
            .block_on(git_dir_diff(root.clone(), "main".into(), "feature".into()))
            .unwrap();
        let added = entries.iter().find(|e| e.rel_path == "added.txt").unwrap();
        assert_eq!(added.status, "A");
        assert_eq!(added.left_size, None);
        assert_eq!(added.right_size, Some("new file\n".len() as u64));
        let modified = entries.iter().find(|e| e.rel_path == "file.txt").unwrap();
        assert_eq!(modified.status, "M");
        assert_eq!(modified.left_size, Some("line1\nline2\nline3\n".len() as u64));
        assert_eq!(modified.right_size, Some("line1\nline2-feature\nline3\n".len() as u64));
    }

    #[test]
    fn graph_two_lanes_and_merge_base() {
        let (_tmp, root) = fixture_repo();
        let g = rt()
            .block_on(git_graph(root.clone(), "main".into(), "feature".into()))
            .unwrap();
        // 此时分叉前 main 无独有提交：两个 feature 提交均在 lane 1
        assert_eq!(g.commits.len(), 2);
        assert!(g.commits.iter().all(|c| c.lane == 1));
        // 分叉点 = main 的 HEAD（fixture 中 main 仅 c1 一个提交）
        let main_sha = run_git(&root, &["rev-parse", "main"]).unwrap().trim().to_string();
        assert_eq!(Some(main_sha), g.merge_base);
        // 顺序：新→旧
        assert!(g.commits[0].message.contains("f2"));
        assert!(g.commits[1].message.contains("f1"));
        assert_eq!(g.current_branch, "main");
        // cherry(main, feature)：目标非当前分支且无等价提交 → 空
        assert!(g.already_in_current.is_empty());
        // lane 0 场景：main 上再提交一个，两侧各有独有提交
        let (_t2, root2) = fixture_repo();
        std::fs::write(std::path::Path::new(&root2).join("m.txt"), "m").unwrap();
        run_git(&root2, &["add", "m.txt"]).unwrap();
        run_git(&root2, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "m1"]).unwrap();
        let g2 = rt()
            .block_on(git_graph(root2, "main".into(), "feature".into()))
            .unwrap();
        assert!(g2.commits.iter().any(|c| c.lane == 0 && c.message.contains("m1")));
        assert!(g2.commits.iter().any(|c| c.lane == 1));
    }

}
