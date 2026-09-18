#!/usr/bin/env bash
# deepseek-offload installer — see README.md for what it wires up.
#
#   git submodule add <this repo> .agents/deepseek-offload
#   .agents/deepseek-offload/install.sh --with-mcp-config
#
# Every flag is forwarded to install/configure.mjs; `--help` documents them.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "deepseek-offload: node is required (>= 18)" >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "deepseek-offload: node >= 18 required, found $(node -v)" >&2
  exit 1
fi

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'USAGE'
deepseek-offload install.sh

  --project DIR            project that owns the jobs (default: this directory)
  --dsh-root DIR           DeepSeek Harness source checkout (default: $DSH_ROOT,
                           else ~/deepseek-harness)
  --dsh-home DIR           Harness home holding profiles/sessions (default: $DSH_HOME,
                           else ~/.dsh)
  --with-mcp-config        also register the bridge in .mcp.json and
                           .agents/mcp_config.json for the calling agents
  --permission allow|reject
                           permission policy written into that entry
                           (default: allow — delegated work runs unattended)
  --no-project-links       do not create the project's .agents entries
                           (bridge, plugin, skill)
  --no-agent-rule          do not inject the orchestrator rule into the
                           project's CLAUDE.md/AGENTS.md
  --rule-file PATH         inject the rule into PATH instead of the default
                           CLAUDE.md/AGENTS.md candidates (repeatable)
  --link-plugin            symlink the workspace plugin into $DSH_HOME
                           instead of copying it (for plugin development)
  --model NAME             model every delegated session runs on
                           (default: $DEEPSEEK_OFFLOAD_MODEL, else
                           deepseek-flash)
  --with-vision-subagent   also add the read_image_vision subagent to the
                           Harness `standard` preset
  --dry-run                print the plan without writing anything
  --uninstall              remove the managed rows, link, and MCP entries
  --json                   machine-readable result

Examples
  .agents/deepseek-offload/install.sh --with-mcp-config
  .agents/deepseek-offload/install.sh --dry-run
  .agents/deepseek-offload/install.sh --uninstall
USAGE
  exit 0
fi

exec node "$HERE/install/configure.mjs" "$@"
