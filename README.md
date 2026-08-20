# Compare

一个类 [Beyond Compare](https://www.scootersoftware.com/) 的跨平台文件对比工具，基于 **Tauri 2 + Rust + React** 构建，并深度集成了 **Git 分支对比、提交树图与 cherry-pick** 能力。

## 界面与功能

应用为**单页设计**：顶部选择 2-4 个对比源（目录 / 文件 / git 分支），
目录对比、文本对比、十六进制对比、Git 树为同一页面内的四个页签——双击目录中的文件即切到文本对比页签，全程无弹层。

```
┌──────────────────────────────────────────────────────────────────────┐
│ 侧1 [📁目录或文件|🌿分支] <源>  侧2 <源> [×] ＋ ⟳        （最多 4 路） │
├──────────────────────────────────────────────────────────────────────┤
│ [📁 目录对比] [📄 文本对比] [🔢 十六进制对比] [🌳 Git 树]              │
├──────┬──────────────┬──────────────┬──────────────┬────────┬────────┐
│ 状态 │ ◀ 侧1        │ 侧2          │ 侧3 ▶        │ 大小1.. │ …      │
│  =   │ equal.txt    │ equal.txt    │ equal.txt    │ 100B×3 │        │
│  ≠   │ main.rs [a]  │ main.rs [a]  │ main.rs [b]  │ …      │        │
│  ◇   │ ░░(无)░░     │ only.md [a]  │ ░░(无)░░     │        │        │
└──────┴──────────────┴──────────────┴──────────────┴────────┴────────┘
```

### 多路对比（2-4 路）
- **＋ 增加源**：目录对比 / 文件文本对比 / 十六进制对比均支持 3-4 路并排
- **多路目录**：名称栏按「相等类」字母标记（`[a][a][b]` = 侧1侧2 内容相同、侧3 不同），
  孤儿文件只在所属一侧显示（斜纹占位）；多路模式只读，复制/删除操作保留在两路模式
- **多路文本**：以第 1 侧为基准做行级对齐（Rust 端 `diff_texts_multi`），
  三/四栏并排显示各自版本与行号，差异行着色；末侧可编辑与保存
- git 分支对比固定两路（base ⇄ target 语义）

### 源选择（每侧独立，三选一）
- **📄 文件**：选择单个文件，各侧都是文件时直接进入文本对比（并可切十六进制页签）
- **📁 目录**：文件夹对比（快速 mtime / 精确 blake3 哈希）
- **🌿 分支**：同一仓库的两个分支对比——无需切换 checkout，
  文件状态（M/A/D/R）与大小直接来自 `git diff` 与 `git ls-tree`
- **📝 空白对比**：不选任何文件，直接打开双栏编辑器粘贴/输入两侧内容，
  输入实时防抖对比，可随时在「✎ 编辑原文」与「◫ 对比视图」之间切换；
  文件会话同样可用这两个模式互切（原文模式支持多行粘贴）

### 📁 目录对比（Beyond Compare 式双栏）
- 左右各有独立名称列：孤儿文件只出现在所属一侧（斜纹占位），按状态整行着色
  （不同=红、仅一侧=蓝、较新=琥珀），图标状态一目了然
- 目录模式：快速 mtime / 精确 blake3 哈希两种模式，左右复制（同步 mtime）、删除（带确认）
- 分支模式：git 状态徽标 + 各侧文件大小，只读
- 双击文件 → **下钻文本对比**（覆盖层，「← 返回」回目录；磁盘文件可切换十六进制视图）

### 🌳 Git 树（分支模式专属）
- **双车道提交图**：base 侧（蓝）与 target 侧（绿）自分叉点 ◆ 展开，按时间新→旧排列
- 已通过 patch 等价检测标记「已在当前分支」的提交（划线灰显，不可勾选）
- 勾选 target 侧提交 → **cherry-pick 到当前检出分支**
- **冲突处理**：冲突发生时切换为冲突面板，一键打开「ours(HEAD) ↔ 工作区（含冲突标记）」编辑视图，
  修改保存后返回点「继续」完成摘取；也可放弃回滚
- 工作区不干净时自动拦截提示

### 📄 文本对比（2-4 栏并排，diff 算法在 Rust 端）
- **行级差异识别**：Myers 算法（similar 库）计算行对齐，
  多路时以第 1 侧为基准逐侧 diff 再按基准行号+间隙合并成对齐矩阵
- **行内字符级差异**：对配对的改动行再做字符级 diff，精确高亮到变化的字符
- 相同区域可折叠（默认展开）、差异块导航（◀ ▶）、差异统计
- 各栏行号独立且随差异着色；栏头分色（蓝/绿/琥珀/紫）
- 末侧可编辑（磁盘文件）：双击行内编辑、`Ctrl+S` 保存
- 块级合并：末栏左侧中缝 `▶` 采纳相邻栏差异块、`✕` 丢弃末栏差异块

### 🔢 十六进制对比（2-4 栏并排）
- 每侧一个 hex dump 面板（偏移 + 十六进制 + ASCII）
- 各侧不全部相同的字节统一高亮；mmap + 窗口按需加载支持 GB 级文件
- 一键跳到首个差异字节

### 🔢 十六进制对比（下钻视图）
- 字节级双栏 hex dump（偏移 + 十六进制 + ASCII）、差异字节高亮
- mmap + 窗口按需加载，支持 GB 级文件；一键跳到首个差异字节

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 18 + TypeScript + Vite + TailwindCSS + zustand + @tanstack/react-virtual |
| 后端 | Rust + Tauri 2 |
| diff 引擎 | [similar](https://crates.io/crates/similar)（Myers 行级 + 字符级行内 diff，全部在 Rust 侧计算） |
| 目录扫描 | jwalk 并行遍历 + blake3 内容哈希 |
| Hex | memmap2 内存映射 + 窗口化读取 |
| Git | 调用系统 git CLI（引用/路径作为独立参数传递并做格式校验，防注入）；提交图基于 `rev-list` 对称差 + `git cherry` patch 等价检测 |

## 开发

```bash
npm install

# Linux（无 sudo 环境准备 WebKitGTK 开发包，详见 scripts/setup-sysdeps.sh）
bash scripts/setup-sysdeps.sh
export PKG_CONFIG_PATH="$PWD/.sysdeps/usr/lib/x86_64-linux-gnu/pkgconfig:$PKG_CONFIG_PATH"

# 桌面系统需要（有 sudo 的常规环境）
# sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev

npm run tauri dev    # 开发调试
cargo test           # 后端单元测试（diff 引擎 / 目录扫描 / git 封装与提交图端到端）
npm run build        # 前端类型检查 + 生产构建
```

> **浏览器调试 UI**：`npm run dev` 后用浏览器打开：
> `?demo=dir`（两路目录）、`?demo=dir3`（三路目录）、`?demo=file`（文件文本/Hex 对比）、
> `?demo=git`（分支对比 + Git 树）。非 Tauri 环境自动启用 mock 数据（`src/lib/mock.ts`）。

> 国内网络环境：`src-tauri/.cargo/config.toml` 已配置 rsproxy 镜像加速依赖下载。

## 构建/发布

```bash
npm run tauri build
```

产物：Windows `msi/nsis`、macOS `dmg/app`、Linux `AppImage/deb`。

推送到 GitHub 后，`.github/workflows/build.yml` 会在 Windows / macOS / Linux 三平台自动构建。

## 项目结构

```
├── src/
│   ├── components/
│   │   ├── page/             # 单页主界面：源选择器 / 目录对比网格 / Git 树 / 下钻覆盖层
│   │   ├── text-compare/     # 文本对比（虚拟滚动/折叠/编辑/块合并）
│   │   └── hex-compare/      # 十六进制对比
│   ├── stores/               # zustand：对比源与下钻状态、通知
│   └── lib/                  # 类型化 invoke 封装 / DTO / 工具函数
└── src-tauri/
    ├── src/diff/text.rs      # similar 封装：行级 + 行内字符级 diff
    └── src/commands/         # Tauri commands: text / dir / hex / git（含 git_dir_diff、git_graph）
```

## 安全说明

- git 操作通过参数数组调用系统 git（不经 shell），引用名做白名单校验，防止选项注入
- 删除 / 覆盖文件与 git 写操作前均有状态检查或确认对话框

## 已知限制（路线图）

- 暂不支持目录与分支混合对比（两侧需同为目录或同为同仓库分支）
- 文本编辑暂不支持增删整行（可通过块级 `▶`/`✕` 操作间接实现）
- 超长行（>4096 字符）行内差异退化为整行高亮；行内容超宽裁剪显示（暂无水平滚动）
- 提交图为双车道简化绘制，暂不支持复杂分叉/合并拓扑（merge commit 折叠为车道归属）
- 未内置语法高亮（计划接入 shiki）；三路合并（merge）与图片对比尚未实现
