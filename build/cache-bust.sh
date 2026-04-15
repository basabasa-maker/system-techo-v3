#!/bin/bash
# cache-bust.sh
# デプロイ前に実行し、HTML/JSファイル内の
#   __BUILD_VERSION__  もしくは
#   既存の YYYYMMDD-HHMMSS 形式バージョン（v= または BUILD_VERSION= 直後）
# を現在時刻ベースの新しいバージョン文字列に置換する。
# PWAキャッシュバスター対策（v1白紙化の教訓）。

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_VERSION="$(date '+%Y%m%d-%H%M%S')"

echo "[cache-bust] BUILD_VERSION=${BUILD_VERSION}"

TARGETS=(
  "${ROOT_DIR}/index.html"
  "${ROOT_DIR}/sw.js"
)

for f in "${TARGETS[@]}"; do
  if [[ -f "$f" ]]; then
    # 1. プレースホルダ __BUILD_VERSION__ を置換
    sed -i.bak "s|__BUILD_VERSION__|${BUILD_VERSION}|g" "$f"
    # 2. 既存の ?v=YYYYMMDD-HHMMSS 形式も新しい値に更新（再ビルド時用）
    sed -i.bak -E "s|\?v=[0-9]{8}-[0-9]{6}|?v=${BUILD_VERSION}|g" "$f"
    # 3. sw.js の BUILD_VERSION = "YYYYMMDD-HHMMSS" 定数も更新
    sed -i.bak -E "s|BUILD_VERSION = \"[0-9]{8}-[0-9]{6}\"|BUILD_VERSION = \"${BUILD_VERSION}\"|g" "$f"
    rm -f "${f}.bak"
    echo "[cache-bust] updated: ${f}"
  fi
done

echo "[cache-bust] done."
