#!/bin/bash
# Open a PDF, mark it up, QUIT, reopen it, edit those marks, quit, reopen again.
# Each phase is a separate app launch: "reopen" only means something if the
# process actually went away.
set -e
cd "$(dirname "$0")/.."
SRC="${1:-test/fixtures/plain.pdf}"
TMP="$(mktemp -d)"
WORK="$TMP/$(basename "$SRC")"
cp "$SRC" "$WORK"
echo "working on a copy: $WORK"
for phase in 1 2 3; do
  npx electron test/reopen.js --phase "$phase" --work "$WORK" || { echo "phase $phase failed"; exit 1; }
done
echo "reopen test passed — $WORK"
