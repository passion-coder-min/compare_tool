//! 文件夹对比：并行遍历两侧目录，快速模式按 size+mtime 判定，
//! 深度模式对同尺寸文件用 blake3 内容哈希精确判定。

use std::{
    collections::HashMap,
    fs,
    io::{BufReader, Read},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use anyhow::Context;
use filetime::{set_file_times, FileTime};
use jwalk::WalkDir;
use serde::Serialize;

use super::{err_str, CmdResult};

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum DirStatus {
    OnlyLeft,
    OnlyRight,
    Same,
    Different,
    LeftNewer,
    RightNewer,
    Error,
}

#[derive(Serialize, Clone, Debug)]
pub struct DirEntryDiff {
    pub rel_path: String,
    pub is_dir: bool,
    pub status: DirStatus,
    pub left_size: Option<u64>,
    pub right_size: Option<u64>,
    /// unix 毫秒时间戳
    pub left_mtime: Option<u64>,
    pub right_mtime: Option<u64>,
    pub error: Option<String>,
}

#[derive(Clone)]
struct Meta {
    is_dir: bool,
    size: u64,
    mtime_ms: u64,
}

fn scan_tree(root: &Path) -> anyhow::Result<HashMap<String, Meta>> {
    let mut map = HashMap::new();
    for entry in WalkDir::new(root).skip_hidden(false).follow_links(false) {
        let entry = match entry {
            Ok(e) => e,
            // 单个条目读取失败不中断整个扫描
            Err(_) => continue,
        };
        let path = entry.path();
        let rel = match path.strip_prefix(root) {
            Ok(r) => r,
            Err(_) => continue,
        };
        if rel.as_os_str().is_empty() {
            continue;
        }
        let md = match fs::metadata(entry.path()) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mtime_ms = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        map.insert(
            rel.to_string_lossy().replace('\\', "/"),
            Meta {
                is_dir: md.is_dir(),
                size: md.len(),
                mtime_ms,
            },
        );
    }
    Ok(map)
}

fn hash_file(path: &Path) -> anyhow::Result<[u8; 32]> {
    let f = fs::File::open(path).with_context(|| format!("无法打开文件: {}", path.display()))?;
    let mut reader = BufReader::with_capacity(1 << 20, f);
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(*hasher.finalize().as_bytes())
}

#[tauri::command]
pub async fn compare_dirs(
    left_dir: String,
    right_dir: String,
    use_hash: bool,
) -> CmdResult<Vec<DirEntryDiff>> {
    let left_root = PathBuf::from(&left_dir);
    let right_root = PathBuf::from(&right_dir);
    if !left_root.is_dir() {
        return Err(format!("左侧不是有效目录: {left_dir}"));
    }
    if !right_root.is_dir() {
        return Err(format!("右侧不是有效目录: {right_dir}"));
    }

    let left = scan_tree(&left_root).map_err(err_str)?;
    let right = scan_tree(&right_root).map_err(err_str)?;

    // 合并键并排序，保证输出顺序稳定
    let mut keys: Vec<&String> = left.keys().chain(right.keys()).collect();
    keys.sort();
    keys.dedup();

    let mut out = Vec::with_capacity(keys.len());
    for key in keys {
        let (lm, rm) = (left.get(key), right.get(key));
        let entry = match (lm, rm) {
            (Some(l), None) => DirEntryDiff {
                rel_path: key.clone(),
                is_dir: l.is_dir,
                status: DirStatus::OnlyLeft,
                left_size: Some(l.size),
                right_size: None,
                left_mtime: Some(l.mtime_ms),
                right_mtime: None,
                error: None,
            },
            (None, Some(r)) => DirEntryDiff {
                rel_path: key.clone(),
                is_dir: r.is_dir,
                status: DirStatus::OnlyRight,
                left_size: None,
                right_size: Some(r.size),
                left_mtime: None,
                right_mtime: Some(r.mtime_ms),
                error: None,
            },
            (Some(l), Some(r)) => {
                let status = if l.is_dir || r.is_dir {
                    // 目录两侧都存在视为相同（内容差异体现在子文件上）
                    DirStatus::Same
                } else if l.size != r.size {
                    DirStatus::Different
                } else if use_hash {
                    let lp = left_root.join(&key);
                    let rp = right_root.join(&key);
                    match (hash_file(&lp), hash_file(&rp)) {
                        (Ok(lh), Ok(rh)) => {
                            if lh == rh {
                                DirStatus::Same
                            } else {
                                DirStatus::Different
                            }
                        }
                        (Err(e), _) | (_, Err(e)) => {
                            out.push(DirEntryDiff {
                                rel_path: key.clone(),
                                is_dir: l.is_dir,
                                status: DirStatus::Error,
                                left_size: Some(l.size),
                                right_size: Some(r.size),
                                left_mtime: Some(l.mtime_ms),
                                right_mtime: Some(r.mtime_ms),
                                error: Some(e.to_string()),
                            });
                            continue;
                        }
                    }
                } else if l.mtime_ms == r.mtime_ms {
                    DirStatus::Same
                } else if l.mtime_ms > r.mtime_ms {
                    DirStatus::LeftNewer
                } else {
                    DirStatus::RightNewer
                };
                DirEntryDiff {
                    rel_path: key.clone(),
                    is_dir: l.is_dir,
                    status,
                    left_size: Some(l.size),
                    right_size: Some(r.size),
                    left_mtime: Some(l.mtime_ms),
                    right_mtime: Some(r.mtime_ms),
                    error: None,
                }
            }
            (None, None) => unreachable!(),
        };
        out.push(entry);
    }
    Ok(out)
}

/// 跨侧复制：文件覆盖复制并同步 mtime；目录递归复制整个子树（保持 mtime），
/// 保证快速模式下复制完成后对比立即显示相同。
#[tauri::command]
pub async fn copy_path_across(src_path: String, dst_path: String) -> CmdResult<()> {
    let src = PathBuf::from(&src_path);
    let dst = PathBuf::from(&dst_path);
    let md = fs::metadata(&src).map_err(|e| format!("无法读取源路径: {e}"))?;
    if md.is_dir() {
        copy_dir_recursive(&src, &dst).map_err(err_str)?;
        return Ok(());
    }
    copy_file_with_mtime(&src, &dst).map_err(err_str)?;
    Ok(())
}

fn copy_file_with_mtime(src: &Path, dst: &Path) -> anyhow::Result<()> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(src, dst)?;
    if let Ok(st) = fs::metadata(src) {
        let atime = FileTime::from_last_access_time(&st);
        let mtime = FileTime::from_last_modification_time(&st);
        let _ = set_file_times(dst, atime, mtime);
    }
    Ok(())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> anyhow::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let s = entry.path();
        let d = dst.join(entry.file_name());
        if ft.is_dir() {
            copy_dir_recursive(&s, &d)?;
        } else if ft.is_file() {
            copy_file_with_mtime(&s, &d)?;
        }
    }
    // 同步目录本身的 mtime
    if let Ok(st) = fs::metadata(src) {
        let atime = FileTime::from_last_access_time(&st);
        let mtime = FileTime::from_last_modification_time(&st);
        let _ = set_file_times(dst, atime, mtime);
    }
    Ok(())
}

#[tauri::command]
pub async fn delete_path(path: String, is_dir: bool) -> CmdResult<()> {
    let result = if is_dir {
        fs::remove_dir_all(&path)
    } else {
        fs::remove_file(&path)
    };
    result.map_err(|e| format!("删除失败 {path}: {e}"))
}

// ---------- N 路目录对比 ----------

#[derive(Serialize, Clone, Debug)]
pub struct MultiSideMeta {
    pub present: bool,
    pub size: Option<u64>,
    pub mtime_ms: Option<u64>,
}

#[derive(Serialize, Clone, Debug)]
pub struct MultiDirEntry {
    pub rel_path: String,
    pub is_dir: bool,
    pub sides: Vec<MultiSideMeta>,
    /// 每侧的内容相等类索引（相同索引 = 内容相同）；不存在侧为 usize::MAX
    pub class: Vec<usize>,
    /// 所有侧都存在且内容一致
    pub all_equal: bool,
    pub error: Option<String>,
}

/// N 路（>=2）目录对比：扫描所有侧并合并路径，
/// 按相等类标记哪些侧的内容彼此相同（快速模式按 size+mtime，哈希模式按 blake3）。
#[tauri::command]
pub async fn compare_dirs_multi(
    dirs: Vec<String>,
    use_hash: bool,
) -> CmdResult<Vec<MultiDirEntry>> {
    if dirs.len() < 2 {
        return Err("多路目录对比至少需要两侧".into());
    }
    if dirs.len() > 8 {
        return Err("最多支持 8 路对比".into());
    }
    for d in &dirs {
        if !Path::new(d).is_dir() {
            return Err(format!("不是有效目录: {d}"));
        }
    }

    let trees: Vec<HashMap<String, Meta>> = dirs
        .iter()
        .map(|d| scan_tree(Path::new(d)).map_err(err_str))
        .collect::<Result<_, _>>()?;

    let mut keys: Vec<&String> = Vec::new();
    for t in &trees {
        keys.extend(t.keys());
    }
    keys.sort();
    keys.dedup();

    let mut out = Vec::with_capacity(keys.len());
    for key in keys {
        let metas: Vec<Option<&Meta>> = trees.iter().map(|t| t.get(key)).collect();
        let is_dir = metas.iter().flatten().next().map(|m| m.is_dir).unwrap_or(false);
        let sides: Vec<MultiSideMeta> = metas
            .iter()
            .map(|m| MultiSideMeta {
                present: m.is_some(),
                size: m.map(|x| x.size),
                mtime_ms: m.map(|x| x.mtime_ms),
            })
            .collect();

        if is_dir {
            // 目录：全部存在视为一致
            let all_present = sides.iter().all(|s| s.present);
            out.push(MultiDirEntry {
                rel_path: key.clone(),
                is_dir: true,
                class: sides.iter().map(|s| if s.present { 0 } else { usize::MAX }).collect(),
                all_equal: all_present,
                sides,
                error: None,
            });
            continue;
        }

        // 文件：计算相等类
        let mut error = None;
        let mut keys_of: Vec<Option<(u64, u64)>> = Vec::with_capacity(metas.len()); // (size, mtime)
        let mut hashes: Vec<Option<[u8; 32]>> = Vec::with_capacity(metas.len());
        for (i, m) in metas.iter().enumerate() {
            match m {
                None => {
                    keys_of.push(None);
                    hashes.push(None);
                }
                Some(meta) => {
                    keys_of.push(Some((meta.size, meta.mtime_ms)));
                    if use_hash {
                        let p = Path::new(&dirs[i]).join(key);
                        match hash_file(&p) {
                            Ok(h) => hashes.push(Some(h)),
                            Err(e) => {
                                error = Some(e.to_string());
                                hashes.push(None);
                            }
                        }
                    } else {
                        hashes.push(None);
                    }
                }
            }
        }
        let fingerprint = |i: usize| -> Option<Vec<u8>> {
            if let Some(h) = hashes[i] {
                Some(h.to_vec())
            } else {
                keys_of[i].map(|(s, m)| {
                    let mut v = Vec::with_capacity(16);
                    v.extend_from_slice(&s.to_le_bytes());
                    v.extend_from_slice(&m.to_le_bytes());
                    v
                })
            }
        };

        let mut class_ids: Vec<Option<usize>> = vec![None; metas.len()];
        let mut next_class = 0usize;
        for i in 0..metas.len() {
            if class_ids[i].is_some() || metas[i].is_none() {
                continue;
            }
            let fp = fingerprint(i);
            class_ids[i] = Some(next_class);
            for j in (i + 1)..metas.len() {
                if metas[j].is_some() && class_ids[j].is_none() && fingerprint(j) == fp {
                    class_ids[j] = Some(next_class);
                }
            }
            next_class += 1;
        }
        let class: Vec<usize> = class_ids
            .iter()
            .map(|c| c.unwrap_or(usize::MAX))
            .collect();
        let all_equal = sides.iter().all(|s| s.present) && next_class <= 1;
        out.push(MultiDirEntry {
            rel_path: key.clone(),
            is_dir: false,
            sides,
            class,
            all_equal,
            error,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(p: &Path, content: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, content).unwrap();
    }

    #[test]
    fn compare_basic_statuses() {
        let tmp = tempdir();
        let l = tmp.path().join("l");
        let r = tmp.path().join("r");
        write(&l.join("same.txt"), "abc");
        write(&r.join("same.txt"), "abc");
        // 显式固定相同 mtime：避免 CI 文件系统上两次写入落在不同毫秒导致判定为“较新”
        for d in [&l, &r] {
            filetime::set_file_mtime(
                d.join("same.txt"),
                filetime::FileTime::from_unix_time(1_000_000_000, 0),
            )
            .unwrap();
        }
        write(&l.join("only_l.txt"), "x");
        write(&r.join("only_r.txt"), "y");
        write(&l.join("diff_size.txt"), "aaa");
        write(&r.join("diff_size.txt"), "aaaa");
        write(&l.join("sub/nested.txt"), "n1");
        write(&r.join("sub/nested.txt"), "n2");
        // 显式设置不同的 mtime，保证快速模式下判定为"较新"而非依赖写入时序
        filetime::set_file_mtime(
            &l.join("sub/nested.txt"),
            filetime::FileTime::from_unix_time(2_000_000_000, 0),
        )
        .unwrap();
        filetime::set_file_mtime(
            &r.join("sub/nested.txt"),
            filetime::FileTime::from_unix_time(1_000_000_000, 0),
        )
        .unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let out = rt
            .block_on(compare_dirs(
                l.to_string_lossy().into_owned(),
                r.to_string_lossy().into_owned(),
                false,
            ))
            .unwrap();

        let get = |k: &str| out.iter().find(|e| e.rel_path == k).unwrap();
        assert_eq!(get("same.txt").status, DirStatus::Same);
        assert_eq!(get("only_l.txt").status, DirStatus::OnlyLeft);
        assert_eq!(get("only_r.txt").status, DirStatus::OnlyRight);
        assert_eq!(get("diff_size.txt").status, DirStatus::Different);
        // 快速模式下同尺寸不同内容、mtime 不同 → 新旧而非 Different
        assert_eq!(get("sub/nested.txt").status, DirStatus::LeftNewer);
        assert!(out.len() >= 5);
    }

    #[test]
    fn hash_mode_detects_same_size_difference() {
        let tmp = tempdir();
        let l = tmp.path().join("l");
        let r = tmp.path().join("r");
        write(&l.join("a.txt"), "aaa");
        write(&r.join("a.txt"), "bbb");
        let rt = tokio::runtime::Runtime::new().unwrap();
        let out = rt
            .block_on(compare_dirs(
                l.to_string_lossy().into_owned(),
                r.to_string_lossy().into_owned(),
                true,
            ))
            .unwrap();
        assert_eq!(out[0].status, DirStatus::Different);
    }

    #[test]
    fn multi_dir_classes() {
        let tmp = tempdir();
        let (a, b, c) = (tmp.path().join("a"), tmp.path().join("b"), tmp.path().join("c"));
        write(&a.join("same.txt"), "x");
        write(&b.join("same.txt"), "x");
        write(&c.join("same.txt"), "x");
        // 固定相同 mtime，保证快速模式下同类
        for d in [&a, &b, &c] {
            filetime::set_file_mtime(
                d.join("same.txt"),
                filetime::FileTime::from_unix_time(1_000_000_000, 0),
            )
            .unwrap();
        }
        write(&a.join("ab.txt"), "1");
        write(&b.join("ab.txt"), "1");
        write(&c.join("ab.txt"), "22");
        write(&a.join("only.txt"), "z");

        let rt = tokio::runtime::Runtime::new().unwrap();
        let out = rt
            .block_on(compare_dirs_multi(
                vec![
                    a.to_string_lossy().into_owned(),
                    b.to_string_lossy().into_owned(),
                    c.to_string_lossy().into_owned(),
                ],
                false,
            ))
            .unwrap();

        let get = |k: &str| out.iter().find(|e| e.rel_path == k).unwrap();
        let same = get("same.txt");
        assert_eq!(same.class, vec![0, 0, 0]);
        assert!(same.all_equal);
        let ab = get("ab.txt");
        assert_eq!(ab.class[0], ab.class[1]);
        assert_ne!(ab.class[1], ab.class[2]);
        assert!(!ab.all_equal);
        let only = get("only.txt");
        assert_eq!(only.class, vec![0, usize::MAX, usize::MAX]);
        assert!(!only.sides[1].present);
        assert!(!only.all_equal);
    }

    fn tempdir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn copy_dir_recursive_copies_tree() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let tmp = tempdir();
            let src = tmp.path().join("src");
            write(&src.join("a.txt"), "aaa");
            write(&src.join("sub/deep/b.txt"), "bbb");
            // 固定 mtime，验证复制后两侧快速模式判定相同
            let t = filetime::FileTime::from_unix_time(1_000_000_000, 0);
            filetime::set_file_mtime(&src.join("a.txt"), t).unwrap();
            filetime::set_file_mtime(&src.join("sub/deep/b.txt"), t).unwrap();

            let dst = tmp.path().join("dst");
            copy_path_across(
                src.to_string_lossy().into_owned(),
                dst.to_string_lossy().into_owned(),
            )
            .await
            .unwrap();

            assert_eq!(fs::read_to_string(dst.join("a.txt")).unwrap(), "aaa");
            assert_eq!(fs::read_to_string(dst.join("sub/deep/b.txt")).unwrap(), "bbb");
            // 复制后同 mtime → 快速模式对比为相同
            let out = compare_dirs(
                src.to_string_lossy().into_owned(),
                dst.to_string_lossy().into_owned(),
                false,
            )
            .await
            .unwrap();
            for e in &out {
                assert_eq!(e.status, DirStatus::Same, "{} 应为相同", e.rel_path);
            }
        });
    }
}
