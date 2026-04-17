#!/usr/bin/env bash
# Clones upstream Outline at a pinned SHA, applies our overlay (patches +
# ru_RU/translation.json), and runs yarn build. The result lives in .build/outline
# and can be packaged into a Docker image or used directly.
#
# Usage:
#   ./scripts/build.sh                # build using UPSTREAM_SHA from repo root
#   ./scripts/build.sh --sha <sha>    # override the pinned SHA
#   ./scripts/build.sh --skip-build   # apply overlay only, don't run yarn build
#
# Environment:
#   UPSTREAM_REPO  default: https://github.com/outline/outline.git
#   BUILD_DIR      default: ./.build/outline

set -euo pipefail

OVERLAY_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM_REPO="${UPSTREAM_REPO:-https://github.com/outline/outline.git}"
BUILD_DIR="${BUILD_DIR:-$OVERLAY_ROOT/.build/outline}"

SHA=""
SKIP_BUILD=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sha) SHA="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$SHA" ]]; then
  SHA="$(cat "$OVERLAY_ROOT/UPSTREAM_SHA" | tr -d '[:space:]')"
fi
if [[ -z "$SHA" ]]; then
  echo "UPSTREAM_SHA is empty; either pass --sha or populate UPSTREAM_SHA file" >&2
  exit 1
fi

echo ">> overlay: $OVERLAY_ROOT"
echo ">> upstream: $UPSTREAM_REPO @ $SHA"
echo ">> build dir: $BUILD_DIR"

rm -rf "$BUILD_DIR"
mkdir -p "$(dirname "$BUILD_DIR")"

# Shallow-clone default branch first, then fetch the exact pinned SHA. This
# keeps the clone small even when the SHA is not HEAD.
git clone --depth 1 "$UPSTREAM_REPO" "$BUILD_DIR"
pushd "$BUILD_DIR" >/dev/null
git fetch --depth 1 origin "$SHA"
git checkout "$SHA"

echo ">> applying patches"
shopt -s nullglob
for p in "$OVERLAY_ROOT"/overlay/patches/*.patch; do
  echo "   $(basename "$p")"
  # --3way lets git merge when upstream context drifts slightly; if it can't,
  # it leaves conflict markers and exits non-zero so CI catches it loudly.
  git apply --3way --verbose "$p"
done
shopt -u nullglob

echo ">> copying locale files"
mkdir -p shared/i18n/locales/ru_RU
cp "$OVERLAY_ROOT/overlay/shared/i18n/locales/ru_RU/translation.json" \
   shared/i18n/locales/ru_RU/translation.json

popd >/dev/null

if [[ "$SKIP_BUILD" -eq 1 ]]; then
  echo ">> overlay applied; skipping yarn build"
  exit 0
fi

pushd "$BUILD_DIR" >/dev/null
# Upstream uses yarn 4 via corepack — activate it so the right yarn binary runs.
if command -v corepack >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || true
fi
echo ">> yarn install"
yarn install --immutable
echo ">> yarn build"
yarn build
popd >/dev/null

echo ">> done: $BUILD_DIR"
