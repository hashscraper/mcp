#!/usr/bin/env bash
# Build server.mcpb (MCP Bundle) for local (stdio) installs — e.g. Smithery:
#   npm run pack:mcpb                       # -> ./server.mcpb
#   npm run pack:mcpb -- /path/to/out.mcpb  # other output path
#   smithery mcp publish ./server.mcpb -n hashscraper/mcp
# The bundle holds manifest.json, dist/, catalog.json, package.json and production
# dependencies only (node_modules without devDependencies), as the MCPB spec requires
# for node servers. Spec: https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md
set -euo pipefail

MCPB_CLI="@anthropic-ai/mcpb@2.1.2"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:-"$ROOT/server.mcpb"}
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac

# manifest.json and package.json must describe the same release
node -e '
  const m = require(process.argv[1] + "/manifest.json"), p = require(process.argv[1] + "/package.json");
  if (m.version !== p.version) { console.error(`manifest.json version ${m.version} != package.json version ${p.version}`); process.exit(1); }
' "$ROOT"

(cd "$ROOT" && npm run build --silent)

STAGE=$(mktemp -d "${TMPDIR:-/tmp}/hashscraper-mcpb.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
cp -R "$ROOT/dist" "$STAGE/dist"
cp "$ROOT/manifest.json" "$ROOT/catalog.json" "$ROOT/package.json" "$ROOT/package-lock.json" \
   "$ROOT/README.md" "$ROOT/LICENSE" "$STAGE/"
(cd "$STAGE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)

npx -y "$MCPB_CLI" validate "$STAGE/manifest.json"
npx -y "$MCPB_CLI" pack "$STAGE" "$OUT"
echo "MCP bundle: $OUT"
