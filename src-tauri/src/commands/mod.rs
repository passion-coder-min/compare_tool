pub mod dir;
pub mod git;
pub mod hex;
pub mod text;

/// Tauri command 的统一错误类型：序列化为字符串供前端展示
pub type CmdResult<T> = std::result::Result<T, String>;

pub fn err_str<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}
