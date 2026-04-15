#!/bin/bash
# cache-bust.sh
# デプロイ前に実行し、HTML/JSファイル内の __BUILD_VERSION__ を
# 現在時刻ベースのバージョン文字列に置換する。
# PWAキャッシュバスター対策（v1白紙化の教訓）。

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_VERSION="$(date '+%Y%m%d-%H%M%S')"

echo "[cache-bust] BUILD_VERSION=${BUILD_VERSION}"

# 置換対象ファイル
TARGETS=(
  "${ROOT_DIR}/index.html"
  "${ROOT_DIR}/sw.js"
)

for f in "${TARGETS[@]}"; do
  if [[ -f "$f" ]]; then
    # macOS/BSD sed 互換
    sed -i.bak "s|__BUILD_VERSION__|${BUILD_VERSION}|g" "$f"
    rm -f "${f}.bak"
    echo "[cache-bust] updated: ${f}"
  fi
done

echo "[cache-bust] done."
