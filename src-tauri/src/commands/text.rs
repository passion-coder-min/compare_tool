//! 文本对比相关 commands

use std::fs;

use anyhow::Context;

use super::{err_str, CmdResult};
use crate::diff::text::{detect_eol, diff_texts, diff_texts_multi, DiffResult, MultiTextDiff};

fn read_maybe_lossy(path: &str) -> anyhow::Result<String> {
    let bytes = fs::read(path).with_context(|| format!("无法读取文件: {path}"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
pub async fn compare_text(left_path: String, right_path: String) -> CmdResult<DiffResult> {
    let old = read_maybe_lossy(&left_path).map_err(err_str)?;
    let new = read_maybe_lossy(&right_path).map_err(err_str)?;
    Ok(diff_texts(&old, &new))
}

/// 纯内容对比（git 分支文件、编辑后重新计算差异等场景复用）
#[tauri::command]
pub async fn compare_text_content(left: String, right: String) -> DiffResult {
    diff_texts(&left, &right)
}

/// N 路（2..=8）内容对比：以第 0 侧为基准对齐
#[tauri::command]
pub async fn compare_text_multi(texts: Vec<String>) -> CmdResult<MultiTextDiff> {
    if texts.len() < 2 {
        return Err("多路对比至少需要两侧内容".into());
    }
    if texts.len() > 8 {
        return Err("最多支持 8 路对比".into());
    }
    Ok(diff_texts_multi(&texts))
}

#[derive(serde::Serialize)]
pub struct TextFile {
    pub content: String,
    pub eol: String,
}

#[tauri::command]
pub async fn read_text_file(path: String) -> CmdResult<TextFile> {
    let content = read_maybe_lossy(&path).map_err(err_str)?;
    Ok(TextFile {
        eol: detect_eol(&content).to_string(),
        content,
    })
}

#[tauri::command]
pub async fn save_file(path: String, content: String) -> CmdResult<()> {
    fs::write(&path, content)
        .with_context(|| format!("无法写入文件: {path}"))
        .map_err(err_str)
}

/// 探测路径类型：file / dir / missing
#[tauri::command]
pub async fn path_kind(path: String) -> CmdResult<&'static str> {
    match fs::symlink_metadata(&path) {
        Ok(md) => Ok(if md.is_dir() { "dir" } else { "file" }),
        Err(_) => Ok("missing"),
    }
}
