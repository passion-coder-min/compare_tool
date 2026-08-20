//! 文本 diff 引擎：基于 similar，输出左右对齐的行级结果 + 行内字符级差异区间。
//! 所有计算在 Rust 侧完成，前端只负责渲染。

use serde::Serialize;
use similar::{Algorithm, ChangeTag, TextDiff};

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum LineKind {
    Equal,
    Delete,
    Insert,
}

/// 行内差异高亮区间，[start, end) 为 Unicode 字符索引
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct InlineSpan {
    pub start: usize,
    pub end: usize,
}

#[derive(Serialize, Clone, Debug)]
pub struct DiffLine {
    pub text: String,
    pub kind: LineKind,
    /// 左侧为旧行号、右侧为新行号；占位填充为 None
    pub number: Option<u32>,
    pub inline: Vec<InlineSpan>,
}

/// 一个显示行：左右各一个可选的行（删除块较短一侧为 None 占位）
#[derive(Serialize, Clone, Debug)]
pub struct DiffRow {
    pub left: Option<DiffLine>,
    pub right: Option<DiffLine>,
}

#[derive(Serialize, Clone, Copy, Debug, Default)]
pub struct DiffStats {
    pub removed: u32,
    pub added: u32,
    pub blocks: u32,
}

#[derive(Serialize, Clone, Debug)]
pub struct DiffResult {
    pub rows: Vec<DiffRow>,
    pub stats: DiffStats,
    /// 右侧文本使用的换行符，保存编辑结果时沿用
    pub eol: String,
}

/// 行内 diff 的单行最大字符数，超过则整行高亮（防止超长行拖慢计算）
const INLINE_DIFF_MAX_CHARS: usize = 4096;

fn split_lines(s: &str) -> Vec<&str> {
    if s.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<&str> = s.split('\n').collect();
    // 末尾换行产生的空元素移除，与编辑器行语义一致
    if lines.last() == Some(&"") {
        lines.pop();
    }
    lines
        .into_iter()
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect()
}

pub fn detect_eol(s: &str) -> &'static str {
    match s.find('\n') {
        Some(pos) if pos > 0 && s.as_bytes()[pos - 1] == b'\r' => "\r\n",
        Some(_) => "\n",
        // 无换行符时，含 \r 视为旧 Mac 风格
        None if s.contains('\r') => "\r",
        None => "\n",
    }
}

pub fn diff_texts(old: &str, new: &str) -> DiffResult {
    let old_lines = split_lines(old);
    let new_lines = split_lines(new);

    let diff = TextDiff::configure()
        .algorithm(Algorithm::Myers)
        .newline_terminated(false)
        .diff_slices(&old_lines, &new_lines);

    let mut rows: Vec<DiffRow> = Vec::new();
    let mut stats = DiffStats::default();

    // 连续的 Delete/Insert 缓冲，遇到 Equal 或结束时按行配对输出
    let mut pending_del: Vec<DiffLine> = Vec::new();
    let mut pending_ins: Vec<DiffLine> = Vec::new();

    fn flush(
        pending_del: &mut Vec<DiffLine>,
        pending_ins: &mut Vec<DiffLine>,
        rows: &mut Vec<DiffRow>,
        stats: &mut DiffStats,
    ) {
        if pending_del.is_empty() && pending_ins.is_empty() {
            return;
        }
        stats.blocks += 1;
        stats.removed += pending_del.len() as u32;
        stats.added += pending_ins.len() as u32;
        let n = pending_del.len().max(pending_ins.len());
        for i in 0..n {
            let mut left = pending_del.get(i).cloned();
            let mut right = pending_ins.get(i).cloned();
            if let (Some(l), Some(r)) = (&mut left, &mut right) {
                let (ls, rs) = inline_diff(&l.text, &r.text);
                l.inline = ls;
                r.inline = rs;
            }
            rows.push(DiffRow { left, right });
        }
        pending_del.clear();
        pending_ins.clear();
    }

    for change in diff.iter_all_changes() {
        match change.tag() {
            ChangeTag::Equal => {
                flush(&mut pending_del, &mut pending_ins, &mut rows, &mut stats);
                rows.push(DiffRow {
                    left: Some(DiffLine {
                        text: change.value().to_string(),
                        kind: LineKind::Equal,
                        number: change.old_index().map(|i| i as u32 + 1),
                        inline: Vec::new(),
                    }),
                    right: Some(DiffLine {
                        text: change.value().to_string(),
                        kind: LineKind::Equal,
                        number: change.new_index().map(|i| i as u32 + 1),
                        inline: Vec::new(),
                    }),
                });
            }
            ChangeTag::Delete => pending_del.push(DiffLine {
                text: change.value().to_string(),
                kind: LineKind::Delete,
                number: change.old_index().map(|i| i as u32 + 1),
                inline: Vec::new(),
            }),
            ChangeTag::Insert => pending_ins.push(DiffLine {
                text: change.value().to_string(),
                kind: LineKind::Insert,
                number: change.new_index().map(|i| i as u32 + 1),
                inline: Vec::new(),
            }),
        }
    }
    flush(&mut pending_del, &mut pending_ins, &mut rows, &mut stats);

    DiffResult {
        rows,
        stats,
        eol: detect_eol(new).to_string(),
    }
}

/// 对配对的删除/插入行做字符级 diff，返回（左侧区间, 右侧区间）
pub fn inline_diff(a: &str, b: &str) -> (Vec<InlineSpan>, Vec<InlineSpan>) {
    let ca: Vec<char> = a.chars().collect();
    let cb: Vec<char> = b.chars().collect();
    if ca == cb {
        return (Vec::new(), Vec::new());
    }
    if ca.len() > INLINE_DIFF_MAX_CHARS || cb.len() > INLINE_DIFF_MAX_CHARS {
        return (whole_span(&ca), whole_span(&cb));
    }

    // 公共前后缀裁剪，只 diff 中段，避免前缀噪声与重复计算
    let mut p = 0;
    while p < ca.len() && p < cb.len() && ca[p] == cb[p] {
        p += 1;
    }
    let mut s = 0;
    while s < ca.len() - p && s < cb.len() - p && ca[ca.len() - 1 - s] == cb[cb.len() - 1 - s] {
        s += 1;
    }

    let mid_a: String = ca[p..ca.len() - s].iter().collect();
    let mid_b: String = cb[p..cb.len() - s].iter().collect();
    let d = TextDiff::configure().diff_chars(&mid_a, &mid_b);

    let mut ls: Vec<InlineSpan> = Vec::new();
    let mut rs: Vec<InlineSpan> = Vec::new();
    for op in d.ops() {
        if op.tag() == similar::DiffTag::Equal {
            continue;
        }
        let orel = op.old_range();
        let nrel = op.new_range();
        if !orel.is_empty() {
            push_span(&mut ls, p + orel.start, p + orel.end);
        }
        if !nrel.is_empty() {
            push_span(&mut rs, p + nrel.start, p + nrel.end);
        }
    }
    (ls, rs)
}

fn whole_span(c: &[char]) -> Vec<InlineSpan> {
    if c.is_empty() {
        Vec::new()
    } else {
        vec![InlineSpan {
            start: 0,
            end: c.len(),
        }]
    }
}

fn push_span(v: &mut Vec<InlineSpan>, start: usize, end: usize) {
    if let Some(last) = v.last_mut() {
        if last.end >= start {
            last.end = last.end.max(end);
            return;
        }
    }
    v.push(InlineSpan { start, end });
}

// ---------- N 路文本对比 ----------

#[derive(Serialize, Clone, Copy, Debug, Default)]
pub struct MultiStats {
    /// 差异块数（连续的不一致行合并为一块）
    pub blocks: u32,
    /// 存在差异的行数
    pub changed: u32,
}

#[derive(Serialize, Clone, Debug)]
pub struct MultiTextDiff {
    /// 每行为 N 个槽位（对齐到第 0 侧行号）；None 表示该侧此处无行
    pub rows: Vec<Vec<Option<DiffLine>>>,
    pub sides: usize,
    /// 各侧的换行符（保存编辑时沿用）
    pub eols: Vec<String>,
    pub stats: MultiStats,
}

/// N 路（2..=8）文本对比：以第 0 侧为基准，第 i 侧与基准做 diff，
/// 再将所有侧的结果按「基准行号 + 间隙」合并成对齐的行槽位矩阵。
pub fn diff_texts_multi(texts: &[String]) -> MultiTextDiff {
    let n = texts.len().max(1);
    let base_lines = split_lines(&texts[0]);

    // 每个非基准侧的投影：基准行号 -> 该侧行（None 表示该侧无此行），
    // 以及各间隙（基准行号 g 之后）插入的行序列
    struct SideMap {
        by_base: std::collections::HashMap<u32, Option<DiffLine>>,
        gaps: std::collections::HashMap<u32, Vec<DiffLine>>,
    }
    let mut side_maps: Vec<SideMap> = Vec::with_capacity(n.saturating_sub(1));
    for t in texts.iter().skip(1) {
        let mut map = SideMap {
            by_base: std::collections::HashMap::new(),
            gaps: std::collections::HashMap::new(),
        };
        let mut current_base: u32 = 0;
        for row in diff_texts(&texts[0], t).rows {
            match (row.left, row.right) {
                (Some(l), r) => {
                    current_base = l.number.unwrap_or(current_base);
                    map.by_base.insert(current_base, r);
                }
                (None, Some(r)) => {
                    map.gaps.entry(current_base).or_default().push(r);
                }
                (None, None) => {}
            }
        }
        side_maps.push(map);
    }

    fn row_is_equal(slots: &[Option<DiffLine>]) -> bool {
        // 全部槽位均存在且均为 equal 才视为一致行
        slots.iter().all(|s| matches!(s, Some(l) if l.kind == LineKind::Equal))
    }

    fn push_slots(
        slots: Vec<Option<DiffLine>>,
        rows: &mut Vec<Vec<Option<DiffLine>>>,
        stats: &mut MultiStats,
        in_block: &mut bool,
    ) {
        if row_is_equal(&slots) {
            *in_block = false;
        } else {
            stats.changed += 1;
            if !*in_block {
                stats.blocks += 1;
                *in_block = true;
            }
        }
        rows.push(slots);
    }

    let mut rows: Vec<Vec<Option<DiffLine>>> = Vec::new();
    let mut stats = MultiStats::default();
    let mut in_block = false;

    for (idx, base_text) in base_lines.iter().enumerate() {
        let base_no = (idx + 1) as u32;
        // 该基准行之前（上一行之后）的间隙插入
        let gap_no = base_no - 1;
        let max_gap = side_maps
            .iter()
            .map(|m| m.gaps.get(&gap_no).map(|v| v.len()).unwrap_or(0))
            .max()
            .unwrap_or(0);
        for j in 0..max_gap {
            let mut slots: Vec<Option<DiffLine>> = Vec::with_capacity(n);
            slots.push(None); // 基准侧自身无插入
            for m in &side_maps {
                slots.push(m.gaps.get(&gap_no).and_then(|v| v.get(j)).cloned());
            }
            push_slots(slots, &mut rows, &mut stats, &mut in_block);
        }
        // 主行：基准槽 + 各侧槽
        let all_equal = side_maps.iter().all(|m| {
            matches!(m.by_base.get(&base_no), Some(Some(l)) if l.kind == LineKind::Equal)
        });
        let mut slots: Vec<Option<DiffLine>> = Vec::with_capacity(n);
        slots.push(Some(DiffLine {
            text: base_text.to_string(),
            kind: if all_equal {
                LineKind::Equal
            } else {
                LineKind::Delete
            },
            number: Some(base_no),
            inline: Vec::new(),
        }));
        for m in &side_maps {
            slots.push(m.by_base.get(&base_no).cloned().flatten());
        }
        push_slots(slots, &mut rows, &mut stats, &mut in_block);
    }
    // 末尾间隙（最后一行之后）
    let end_gap = base_lines.len() as u32;
    let max_gap = side_maps
        .iter()
        .map(|m| m.gaps.get(&end_gap).map(|v| v.len()).unwrap_or(0))
        .max()
        .unwrap_or(0);
    for j in 0..max_gap {
        let mut slots: Vec<Option<DiffLine>> = Vec::with_capacity(n);
        slots.push(None);
        for m in &side_maps {
            slots.push(m.gaps.get(&end_gap).and_then(|v| v.get(j)).cloned());
        }
        push_slots(slots, &mut rows, &mut stats, &mut in_block);
    }

    MultiTextDiff {
        rows,
        sides: n,
        eols: texts.iter().map(|t| detect_eol(t).to_string()).collect(),
        stats,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replace_and_append() {
        let r = diff_texts("a\nb\nc\n", "a\nx\nc\nd\n");
        assert_eq!(r.stats.blocks, 2);
        assert_eq!(r.stats.removed, 1);
        assert_eq!(r.stats.added, 2);
        for row in &r.rows {
            assert!(
                !(row.left.is_none() && row.right.is_none()),
                "不应出现双空行"
            );
        }
        // 替换块：左右配对且行号对齐
        let repl = r
            .rows
            .iter()
            .find(|row| row.left.as_ref().map(|l| l.kind) == Some(LineKind::Delete))
            .unwrap();
        assert_eq!(repl.left.as_ref().unwrap().text, "b");
        assert_eq!(repl.right.as_ref().unwrap().text, "x");
        assert_eq!(repl.left.as_ref().unwrap().number, Some(2));
        assert_eq!(repl.right.as_ref().unwrap().number, Some(2));
    }

    #[test]
    fn pure_delete_pads_left() {
        let r = diff_texts("a\nb\nc\n", "a\nc\n");
        let del = r
            .rows
            .iter()
            .find(|row| row.left.as_ref().map(|l| l.kind) == Some(LineKind::Delete))
            .unwrap();
        assert_eq!(del.left.as_ref().unwrap().text, "b");
        assert!(del.right.is_none(), "右侧应为占位空行");
        assert_eq!(r.stats.removed, 1);
        assert_eq!(r.stats.added, 0);
    }

    #[test]
    fn inline_span_char_indices() {
        let (ls, rs) = inline_diff("hello world", "hallo welt");
        assert!(!ls.is_empty() && !rs.is_empty());
        // 区间不越界且有序
        let n = "hello world".chars().count();
        for s in &ls {
            assert!(s.start < s.end && s.end <= n);
        }
        let m = "hallo welt".chars().count();
        for s in &rs {
            assert!(s.start < s.end && s.end <= m);
        }
    }

    #[test]
    fn identical_lines_no_spans() {
        let (ls, rs) = inline_diff("same", "same");
        assert!(ls.is_empty() && rs.is_empty());
    }

    #[test]
    fn empty_inputs() {
        let r = diff_texts("", "a\n");
        assert_eq!(r.stats.added, 1);
        let r = diff_texts("a\nb\n", "");
        assert_eq!(r.stats.removed, 2);
        let r = diff_texts("", "");
        assert!(r.rows.is_empty());
    }

    #[test]
    fn no_trailing_newline_participates() {
        let r = diff_texts("a\nb", "a\nc");
        assert_eq!(r.stats.blocks, 1);
        assert_eq!(r.stats.removed, 1);
        assert_eq!(r.stats.added, 1);
    }

    #[test]
    fn trailing_newline_only_no_fake_diff() {
        // 行内容已预先剥离 \r\n，仅末尾换行差异不应产生块
        let r = diff_texts("a\nb\n", "a\nb");
        assert_eq!(r.stats.blocks, 0, "仅末尾换行差异不应显示为改动");
    }

    #[test]
    fn crlf_stripped_and_detected() {
        let r = diff_texts("a\r\nb\r\n", "a\r\nx\r\n");
        assert_eq!(r.rows[1].left.as_ref().unwrap().text, "b");
        assert_eq!(r.eol, "\r\n");
    }

    #[test]
    fn eol_detection() {
        assert_eq!(detect_eol("a\r\nb\r\n"), "\r\n");
        assert_eq!(detect_eol("a\nb"), "\n");
        assert_eq!(detect_eol("single"), "\n");
    }

    #[test]
    fn long_line_whole_highlight() {
        let a: String = "x".repeat(5000);
        let b: String = "y".repeat(5000);
        let (ls, rs) = inline_diff(&a, &b);
        assert_eq!(ls, vec![InlineSpan { start: 0, end: 5000 }]);
        assert_eq!(rs, vec![InlineSpan { start: 0, end: 5000 }]);
    }

    // ---------- N 路对比 ----------

    fn slot_texts(row: &[Option<DiffLine>]) -> Vec<Option<&str>> {
        row.iter()
            .map(|s| s.as_ref().map(|l| l.text.as_str()))
            .collect()
    }

    #[test]
    fn multi_three_way_basic() {
        let texts = vec![
            "a\nb\nc\nd\n".to_string(),
            "a\nx\nc\nd\n".to_string(), // 侧1 改了第2行
            "a\nb\nc\ne\n".to_string(), // 侧2 改了第4行
        ];
        let m = diff_texts_multi(&texts);
        assert_eq!(m.sides, 3);
        assert_eq!(m.rows.len(), 4);
        // 第1行全等
        assert_eq!(slot_texts(&m.rows[0]), vec![Some("a"), Some("a"), Some("a")]);
        assert!(row_all_equal(&m.rows[0]));
        // 第2行：基准 b，侧1 x，侧2 b
        assert_eq!(slot_texts(&m.rows[1]), vec![Some("b"), Some("x"), Some("b")]);
        assert_eq!(m.rows[1][0].as_ref().unwrap().kind, LineKind::Delete);
        assert_eq!(m.rows[1][1].as_ref().unwrap().kind, LineKind::Insert);
        assert_eq!(m.rows[1][2].as_ref().unwrap().kind, LineKind::Equal);
        // 第3行全等
        assert!(row_all_equal(&m.rows[2]));
        // 第4行：基准 d，侧1 d，侧2 e
        assert_eq!(slot_texts(&m.rows[3]), vec![Some("d"), Some("d"), Some("e")]);
        assert_eq!(m.stats.blocks, 2);
        assert_eq!(m.stats.changed, 2);
    }

    #[test]
    fn multi_gap_inserts_aligned() {
        let texts = vec![
            "a\nb\n".to_string(),
            "a\nINS1\nb\n".to_string(), // 侧1 在 gap1 插入
            "a\nb\n".to_string(),       // 侧2 无插入
        ];
        let m = diff_texts_multi(&texts);
        // rows: a / [None, INS1, None] / b
        assert_eq!(m.rows.len(), 3);
        assert_eq!(slot_texts(&m.rows[1]), vec![None, Some("INS1"), None]);
        assert_eq!(m.rows[1][1].as_ref().unwrap().kind, LineKind::Insert);
    }

    #[test]
    fn multi_side_deletion_is_none() {
        let texts = vec![
            "a\nb\nc\n".to_string(),
            "a\nc\n".to_string(), // 删除 b
            "a\nb\nc\n".to_string(),
        ];
        let m = diff_texts_multi(&texts);
        assert_eq!(slot_texts(&m.rows[1]), vec![Some("b"), None, Some("b")]);
    }

    #[test]
    fn multi_two_sides_matches_pairwise_shape() {
        let texts = vec!["a\nb\n".to_string(), "a\nx\n".to_string()];
        let m = diff_texts_multi(&texts);
        assert_eq!(m.sides, 2);
        assert_eq!(slot_texts(&m.rows[1]), vec![Some("b"), Some("x")]);
    }

    #[test]
    fn multi_identical_all_equal() {
        let texts = vec!["a\nb\n".to_string(); 3];
        let m = diff_texts_multi(&texts);
        assert_eq!(m.stats.changed, 0);
        assert_eq!(m.stats.blocks, 0);
        assert!(m.rows.iter().all(|r| row_all_equal(r)));
    }

    fn row_all_equal(r: &[Option<DiffLine>]) -> bool {
        r.iter().all(|s| matches!(s, Some(l) if l.kind == LineKind::Equal))
    }
}
