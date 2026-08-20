#!/usr/bin/env bash
# 为无法使用 sudo 的环境准备 Tauri (Linux/WebKitGTK) 编译所需的系统开发包。
# 运行时库已由系统提供，这里仅补齐头文件、.pc 与链接符号链接到项目本地 .sysdeps。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYSDEPS="$ROOT/.sysdeps"
LIBDIR="$SYSDEPS/usr/lib/x86_64-linux-gnu"

if [ -d "$SYSDEPS" ] && [ -n "$(find "$SYSDEPS" -name 'webkit2gtk-4.1.pc' 2>/dev/null)" ] \
   && PKG_CONFIG_PATH="$LIBDIR/pkgconfig" pkg-config --exists webkit2gtk-4.1 javascriptcoregtk-4.1 libsoup-3.0 2>/dev/null; then
  echo ".sysdeps 已就绪: $SYSDEPS"
else
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  cd "$TMP"
  # 注意：libsoup-3.0 / libngtcp2 固定用普通源版本，避免 ESM 源 401
  apt-get download \
    libwebkit2gtk-4.1-dev \
    libjavascriptcoregtk-4.1-dev \
    libsoup-3.0-dev=3.0.7-0ubuntu1 \
    libpsl-dev \
    libsysprof-4-dev \
    libnghttp2-dev \
    libbrotli-dev \
    libxml2-dev \
    zlib1g-dev \
    libsqlite3-dev \
    libnghttp3-dev
  rm -rf "$SYSDEPS"
  mkdir -p "$SYSDEPS"
  for f in *.deb; do dpkg -x "$f" "$SYSDEPS/"; done
fi

# .pc 前缀指向本地目录（头文件真实位置；.so 链接走符号链接）
for pc in "$LIBDIR/pkgconfig"/*.pc; do
  sed -i "s|^prefix=/usr\$|prefix=$SYSDEPS/usr|" "$pc"
done

# 链接用的 .so 符号链接指向系统运行库
for so in libwebkit2gtk-4.1 libjavascriptcoregtk-4.1 libsoup-3.0; do
  src="/usr/lib/x86_64-linux-gnu/${so}.so.0"
  [ -e "$src" ] || src="/lib/x86_64-linux-gnu/${so}.so.0"
  ln -sf "$src" "$LIBDIR/${so}.so"
done

echo "OK — 使用前执行:"
echo "  export PKG_CONFIG_PATH=\"$LIBDIR/pkgconfig:\$PKG_CONFIG_PATH\""
