//! 十六进制对比：mmap 两个文件，按 16 字节/行返回窗口数据，
//! 窗口查询走应用级缓存（Arc 共享映射），避免滚动时反复 mmap。

use std::{
    collections::HashMap,
    fs::File,
    io,
    sync::{Arc, Mutex},
};

use memmap2::Mmap;
use serde::Serialize;

use super::CmdResult;

pub const BYTES_PER_ROW: usize = 16;

#[derive(Serialize, Clone, Debug)]
pub struct HexRow {
    pub offset: u64,
    /// 本行左侧字节（文件末尾不足 16 字节时较短；越过文件末尾为 None）
    pub left: Option<Vec<u8>>,
    pub right: Option<Vec<u8>>,
    /// 差异字节在行内的位置索引（与 left/right 一一对应）
    pub left_diff: Vec<u8>,
    pub right_diff: Vec<u8>,
}

#[derive(Serialize, Clone, Copy, Debug)]
pub struct HexOverview {
    pub left_size: u64,
    pub right_size: u64,
    pub first_diff: Option<u64>,
    pub identical: bool,
}

struct MappedFile {
    size: u64,
    map: Option<Mmap>,
}

impl MappedFile {
    fn open(path: &str) -> io::Result<MappedFile> {
        let f = File::open(path)?;
        let size = f.metadata()?.len();
        // 空文件 mmap 会失败，用 None 表示
        let map = if size > 0 { Some(unsafe { Mmap::map(&f)? }) } else { None };
        Ok(MappedFile { size, map })
    }

    fn slice(&self, off: u64, len: usize) -> Vec<u8> {
        let end = (off.saturating_add(len as u64)).min(self.size);
        if off >= end {
            return Vec::new();
        }
        match &self.map {
            Some(m) => m[off as usize..end as usize].to_vec(),
            None => Vec::new(),
        }
    }
}

/// (left_path, right_path) -> 映射缓存
#[derive(Default)]
pub struct HexState(Mutex<HashMap<(String, String), (Arc<MappedFile>, Arc<MappedFile>)>>);

fn mapped_pair(
    state: &HexState,
    left_path: &str,
    right_path: &str,
    rebuild: bool,
) -> CmdResult<(Arc<MappedFile>, Arc<MappedFile>)> {
    let key = (left_path.to_string(), right_path.to_string());
    let mut cache = state.0.lock().unwrap();
    if rebuild {
        cache.remove(&key);
    } else if let Some(v) = cache.get(&key) {
        return Ok((v.0.clone(), v.1.clone()));
    }
    let pair = (
        Arc::new(MappedFile::open(left_path).map_err(|e| format!("无法打开 {left_path}: {e}"))?),
        Arc::new(MappedFile::open(right_path).map_err(|e| format!("无法打开 {right_path}: {e}"))?),
    );
    cache.insert(key, (pair.0.clone(), pair.1.clone()));
    Ok(pair)
}

/// 对比概览：文件大小、首个差异偏移、是否完全相同。
/// 每次调用都重新打开文件（同时刷新缓存条目）。
#[tauri::command]
pub async fn hex_overview(
    state: tauri::State<'_, HexState>,
    left_path: String,
    right_path: String,
) -> CmdResult<HexOverview> {
    let (l, r) = mapped_pair(&state, &left_path, &right_path, true)?;

    let min_len = l.size.min(r.size);
    let first_diff = find_first_diff(&l, &r, min_len);
    let identical = first_diff.is_none() && l.size == r.size;
    Ok(HexOverview {
        left_size: l.size,
        right_size: r.size,
        first_diff,
        identical,
    })
}

const SCAN_CHUNK: u64 = 4 << 20;

fn find_first_diff(l: &MappedFile, r: &MappedFile, min_len: u64) -> Option<u64> {
    let (Some(lm), Some(rm)) = (&l.map, &r.map) else {
        // 任一为空文件：无重叠字节即无差异（大小差异由 identical 字段体现）
        return None;
    };
    let mut off = 0usize;
    while (off as u64) < min_len {
        let end = ((off as u64) + SCAN_CHUNK).min(min_len) as usize;
        let (ls, rs) = (&lm[off..end], &rm[off..end]);
        if ls != rs {
            for (i, (a, b)) in ls.iter().zip(rs.iter()).enumerate() {
                if a != b {
                    return Some(off as u64 + i as u64);
                }
            }
        }
        off = end;
    }
    None
}

/// 读取一段窗口（start_row 起共 row_count 行，每行 16 字节）
#[tauri::command]
pub async fn read_hex_window(
    state: tauri::State<'_, HexState>,
    left_path: String,
    right_path: String,
    start_row: u64,
    row_count: u32,
) -> CmdResult<Vec<HexRow>> {
    let (l, r) = mapped_pair(&state, &left_path, &right_path, false)?;

    let mut rows = Vec::with_capacity(row_count as usize);
    for i in 0..row_count as u64 {
        let row = start_row + i;
        let offset = row * BYTES_PER_ROW as u64;
        if offset >= l.size && offset >= r.size {
            break;
        }
        let lb = l.slice(offset, BYTES_PER_ROW);
        let rb = r.slice(offset, BYTES_PER_ROW);
        // 按同偏移逐字节比较生成差异位置
        let n = lb.len().max(rb.len());
        let (mut ld, mut rd) = (Vec::new(), Vec::new());
        for k in 0..n {
            match (lb.get(k).copied(), rb.get(k).copied()) {
                (Some(a), Some(b)) if a != b => {
                    ld.push(k as u8);
                    rd.push(k as u8);
                }
                _ => {}
            }
        }
        rows.push(HexRow {
            offset,
            left: if offset >= l.size { None } else { Some(lb) },
            right: if offset >= r.size { None } else { Some(rb) },
            left_diff: ld,
            right_diff: rd,
        });
    }
    Ok(rows)
}

// ---------- N 路十六进制对比 ----------

#[derive(Serialize, Clone, Debug)]
pub struct HexRowMulti {
    pub offset: u64,
    /// 每侧本行字节（越过文件末尾为 None）
    pub sides: Vec<Option<Vec<u8>>>,
    /// 各侧不全部相同的字节位置（行内索引）
    pub diff: Vec<u8>,
}

#[derive(Serialize, Clone, Debug)]
pub struct HexOverviewMulti {
    pub sizes: Vec<u64>,
    pub first_diff: Option<u64>,
    pub identical: bool,
}

#[derive(Default)]
pub struct HexMultiState(Mutex<HashMap<Vec<String>, Vec<Arc<MappedFile>>>>);

fn mapped_multi(
    state: &HexMultiState,
    paths: &[String],
    rebuild: bool,
) -> CmdResult<Vec<Arc<MappedFile>>> {
    let mut cache = state.0.lock().unwrap();
    if rebuild {
        cache.remove(paths);
    } else if let Some(v) = cache.get(paths) {
        return Ok(v.clone());
    }
    let files: Vec<Arc<MappedFile>> = paths
        .iter()
        .map(|p| MappedFile::open(p).map(Arc::new).map_err(|e| format!("无法打开 {p}: {e}")))
        .collect::<Result<_, String>>()?;
    cache.insert(paths.to_vec(), files.clone());
    Ok(files)
}

#[tauri::command]
pub async fn hex_overview_multi(
    state: tauri::State<'_, HexMultiState>,
    paths: Vec<String>,
) -> CmdResult<HexOverviewMulti> {
    if paths.len() < 2 || paths.len() > 8 {
        return Err("多路 hex 对比支持 2..=8 个文件".into());
    }
    let files = mapped_multi(&state, &paths, true)?;
    let sizes: Vec<u64> = files.iter().map(|f| f.size).collect();
    let min_len = sizes.iter().copied().min().unwrap_or(0);
    // 首个“非全体相同”的字节偏移
    let mut first_diff = None;
    let mut off = 0usize;
    'outer: while (off as u64) < min_len {
        let end = ((off as u64) + SCAN_CHUNK).min(min_len) as usize;
        let first = &files[0].map.as_ref().unwrap()[off..end];
        for f in files.iter().skip(1) {
            if f.map.is_none() {
                continue;
            }
            let sl = &f.map.as_ref().unwrap()[off..end];
            if sl != first {
                for k in 0..(end - off) {
                    if files.iter().any(|f| {
                        f.map
                            .as_ref()
                            .map(|m| m[off + k] != first[k])
                            .unwrap_or(false)
                    }) {
                        first_diff = Some(off as u64 + k as u64);
                        break 'outer;
                    }
                }
            }
        }
        off = end;
    }
    let identical = first_diff.is_none() && sizes.iter().all(|s| *s == sizes[0]);
    Ok(HexOverviewMulti {
        sizes,
        first_diff,
        identical,
    })
}

#[tauri::command]
pub async fn read_hex_window_multi(
    state: tauri::State<'_, HexMultiState>,
    paths: Vec<String>,
    start_row: u64,
    row_count: u32,
) -> CmdResult<Vec<HexRowMulti>> {
    let files = mapped_multi(&state, &paths, false)?;
    let max_size = files.iter().map(|f| f.size).max().unwrap_or(0);
    let mut rows = Vec::with_capacity(row_count as usize);
    for i in 0..row_count as u64 {
        let offset = (start_row + i) * BYTES_PER_ROW as u64;
        if offset >= max_size {
            break;
        }
        let sides: Vec<Option<Vec<u8>>> = files
            .iter()
            .map(|f| {
                if offset >= f.size {
                    None
                } else {
                    Some(f.slice(offset, BYTES_PER_ROW))
                }
            })
            .collect();
        // 各侧不全部相同的字节位置
        let row_len = sides.iter().flatten().map(|v| v.len()).max().unwrap_or(0);
        let mut diff = Vec::new();
        for k in 0..row_len {
            let bytes: Vec<Option<u8>> = sides
                .iter()
                .map(|s| s.as_ref().and_then(|v| v.get(k).copied()))
                .collect();
            let present: Vec<u8> = bytes.iter().flatten().copied().collect();
            if present.is_empty() {
                continue;
            }
            if present.iter().any(|b| *b != present[0]) {
                diff.push(k as u8);
            }
        }
        rows.push(HexRowMulti { offset, sides, diff });
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(p: &std::path::Path, bytes: &[u8]) {
        std::fs::write(p, bytes).unwrap();
    }

    #[test]
    fn first_diff_finds_offset() {
        let tmp = tempfile::tempdir().unwrap();
        let (a, b) = (tmp.path().join("a.bin"), tmp.path().join("b.bin"));
        write(&a, &[0u8; 100]);
        let mut content = vec![0u8; 100];
        content[42] = 1;
        write(&b, &content);
        let (l, r) = (MappedFile::open(a.to_str().unwrap()).unwrap(), MappedFile::open(b.to_str().unwrap()).unwrap());
        assert_eq!(find_first_diff(&l, &r, 100), Some(42));
    }

    #[test]
    fn common_prefix_no_diff() {
        let tmp = tempfile::tempdir().unwrap();
        let (a, b) = (tmp.path().join("a.bin"), tmp.path().join("b.bin"));
        write(&a, b"short");
        write(&b, b"short-longer");
        let (l, r) = (MappedFile::open(a.to_str().unwrap()).unwrap(), MappedFile::open(b.to_str().unwrap()).unwrap());
        assert_eq!(find_first_diff(&l, &r, 5), None);
    }

    #[test]
    fn empty_file_handled() {
        let tmp = tempfile::tempdir().unwrap();
        let (a, b) = (tmp.path().join("a.bin"), tmp.path().join("b.bin"));
        write(&a, b"");
        write(&b, b"x");
        let (l, r) = (MappedFile::open(a.to_str().unwrap()).unwrap(), MappedFile::open(b.to_str().unwrap()).unwrap());
        assert!(l.map.is_none());
        assert_eq!(find_first_diff(&l, &r, 0), None);
        assert_eq!(l.slice(0, 16).len(), 0);
        assert_eq!(r.slice(0, 16), b"x");
    }
}
