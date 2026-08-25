#!/bin/zsh
# paperclip launch guard (installed 2026-08-22)
# Purpose: server/dist/**/*.js is compiled output, checked into .gitignore, not source.
# A `git checkout`/branch switch changes src/ instantly but leaves dist/ untouched --
# on 2026-08-21 this let PaperClip boot against dist that no longer matched src (a
# renamed export, a model-registry change), crashing at startup with a SyntaxError.
#
# This wrapper rebuilds the full workspace (not just server/ -- packages/shared and
# packages/plugins/sdk are load-bearing server deps and can go stale independently)
# before every start/restart, so a mismatched dist can never boot.
#
# Deliberately fails LOUD if the emitted dist is actually broken/stale -- but `tsc`'s own
# exit code is NOT that signal: tsc still emits valid JS for every package even when it
# reports an unrelated type error (no `noEmitOnError` set), and this repo routinely carries
# in-progress WIP with a real, known, non-blocking type error. Treating `pnpm run build`'s
# exit code as "is dist safe to run" caused a real ~10min outage on 2026-08-22 (a crash-restart
# loop against a doomed build that would never exit 0 on a dirty tree). Check the actual
# artifact instead: does dist/index.js exist and parse.
#
# NOTE: PaperClip's launch args now live HERE, not in the plist (the plist just calls
# this script, same shape as ~/bin/omlx-launch-guard.sh).
REPO=/Users/trev/paperclip
export PATH="/opt/homebrew/bin:$PATH"

# Network bind: tailnet-only (Tailscale IP), NOT the raw LAN and NOT loopback.
# server.bind=tailnet => the control plane listens on `tailscale ip -4` (e.g. 100.95.8.81) only;
# 127.0.0.1:3100 stops responding, so localhost tooling must target the tailnet host
# (bin/deploy's health check probes the tailnet IP too). Reversible: delete this line to fall
# back to the config-file / plist bind.
export PAPERCLIP_BIND=tailnet

cd "$REPO"

DIST="$REPO/server/dist/index.js"
# Rebuild ONLY when dist is missing or actually stale vs src (e.g. after a git checkout /
# branch switch -- the 08-21 stale-dist crash this guard exists for). bin/deploy already builds
# fresh dist before it restarts, and a KeepAlive/manual restart of an unchanged tree needs no
# rebuild -- the old UNCONDITIONAL `pnpm run build` burned a full ~37s workspace compile on
# EVERY launch (a second redundant build right after every deploy, and on every crash cycle).
if [ ! -f "$DIST" ] || [ -n "$(find server/src packages/*/src ui/src -type f \( -name '*.ts' -o -name '*.tsx' \) ! -name '*.test.ts' ! -name '*.test.tsx' ! -path '*/__tests__/*' -newer "$DIST" 2>/dev/null | head -1)" ]; then
  echo "[launch] dist missing or stale vs src -> rebuilding workspace" >&2
  pnpm run build || true   # tsc exit != 0 doesn't mean dist is broken/stale -- don't abort on it
else
  echo "[launch] dist fresh vs src -> skipped rebuild (saved a full workspace build)" >&2
fi
if [ ! -f "$DIST" ]; then
  echo "FATAL: build produced no $DIST" >&2
  exit 1
fi
if ! /opt/homebrew/bin/node --check "$DIST"; then
  echo "FATAL: $DIST fails syntax check" >&2
  exit 1
fi

exec /opt/homebrew/bin/node \
  --import "$REPO/server/node_modules/tsx/dist/loader.mjs" \
  "$DIST"
