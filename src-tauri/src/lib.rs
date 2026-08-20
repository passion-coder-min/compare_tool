mod commands;
mod diff;

use commands::hex::{HexMultiState, HexState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(HexState::default())
        .manage(HexMultiState::default())
        .invoke_handler(tauri::generate_handler![
            // 文本对比
            commands::text::compare_text,
            commands::text::compare_text_content,
            commands::text::compare_text_multi,
            commands::text::read_text_file,
            commands::text::save_file,
            commands::text::path_kind,
            // 文件夹对比
            commands::dir::compare_dirs,
            commands::dir::compare_dirs_multi,
            commands::dir::copy_path_across,
            commands::dir::delete_path,
            // 十六进制对比
            commands::hex::hex_overview,
            commands::hex::read_hex_window,
            commands::hex::hex_overview_multi,
            commands::hex::read_hex_window_multi,
            // git
            commands::git::git_open_repo,
            commands::git::git_status,
            commands::git::git_diff_refs,
            commands::git::git_dir_diff,
            commands::git::git_graph,
            commands::git::git_file_content,
            commands::git::git_commits_between,
            commands::git::git_cherry_pick,
            commands::git::git_stage_files,
            commands::git::git_cherry_pick_continue,
            commands::git::git_cherry_pick_abort,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
