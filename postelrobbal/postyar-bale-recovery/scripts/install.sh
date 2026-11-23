#!/usr/bin/env bash
set -euo pipefail
cd /home/postyarh/postelrobbal

SRC='app/src/providers/bale/bale.ts'
DST='app/dist/providers/bale/bale.js'
PATCH_SRC='postyar-bale-recovery/app/src/providers/bale/bale.ts'
PATCH_DST='postyar-bale-recovery/app/dist/providers/bale/bale.js'

EXPECTED_SRC=''
EXPECTED_DST=''
# SHA-256 values are filled from the audited collector snapshot.
EXPECTED_SRC='85d0e5e773dec5a3ac07559390cff26821d7592d3ecc6c16424754e0d4408bff'
EXPECTED_DST='9d1dde848562356ad646b196b89c24cf230f5d82f6bd9805fc2e2325d7cf0336'

for f in "$SRC" "$DST" "$PATCH_SRC" "$PATCH_DST"; do
  [[ -f "$f" ]] || { echo "STOP: missing $f" >&2; exit 1; }
done
actual_src=$(sha256sum "$SRC" | awk '{print $1}')
actual_dst=$(sha256sum "$DST" | awk '{print $1}')
[[ "$actual_src" == "$EXPECTED_SRC" ]] || { echo "STOP: source hash mismatch; no files changed" >&2; exit 2; }
[[ "$actual_dst" == "$EXPECTED_DST" ]] || { echo "STOP: runtime hash mismatch; no files changed" >&2; exit 3; }

stamp=$(date +%Y%m%d-%H%M%S)
cp -p "$SRC" "$SRC.bak-$stamp"
cp -p "$DST" "$DST.bak-$stamp"
install -m 0644 "$PATCH_SRC" "$SRC"
install -m 0644 "$PATCH_DST" "$DST"
echo "PATCH_APPLIED source=$(sha256sum "$SRC" | awk '{print $1}') runtime=$(sha256sum "$DST" | awk '{print $1}')"
echo "BACKUPS=$SRC.bak-$stamp,$DST.bak-$stamp"
