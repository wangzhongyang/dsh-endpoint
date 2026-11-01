#!/usr/bin/env bash
# Recreate the P0 spike in a throwaway DSH_HOME.
#
#   ./spike/run.sh [dsh-home]
#
# Requires the DSH Desktop bundle on macOS. Nothing here touches your real
# profiles or credentials.
set -euo pipefail

HOME_DIR="${1:-/tmp/dsh-ep-spike-home}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="/Applications/DSH Desktop.app/Contents/Frameworks/DSH Desktop Helper.app/Contents/MacOS/DSH Desktop Helper"
BIN="/Applications/DSH Desktop.app/Contents/Resources/app.asar/node_modules/@deepseek-ai/dsh/lib/bin.js"

rm -rf "$HOME_DIR"
mkdir -p "$HOME_DIR/profiles/p0" "$HOME_DIR/workspace"

cat > "$HOME_DIR/profiles/p0/package.json" <<EOF
{
  "name": "dsh-profile-p0",
  "private": true,
  "dependencies": { "dsh-endpoint-spike": "link:$ROOT/spike" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } }
}
EOF

cat > "$HOME_DIR/profiles/p0/pnpm-workspace.yaml" <<'EOF'
packages:
  - .
nodeLinker: hoisted
autoInstallPeers: false
EOF

cat > "$HOME_DIR/profiles/p0/cordis.patch.yml" <<'EOF'
- id: headless-runner
  disabled: true
- id: headless-startup
  disabled: true
- insert:
    - id: workspace
      name: '@deepseek-ai/dsh-workspace'
    - id: dsh-endpoint-spike
      name: dsh-endpoint-spike
EOF

(cd "$HOME_DIR/profiles/p0" && pnpm install --reporter=silent)

DSH_HOME="$HOME_DIR" DSH_ENDPOINT_SPIKE_WORKSPACE="$HOME_DIR/workspace" ELECTRON_RUN_AS_NODE=1 \
  "$NODE" "$BIN" --profile p0
