# deepseek-offload

Delegate long, token-heavy, or parallelizable work from any MCP-capable agent (Claude Code,
Gemini/Antigravity, Codex CLI, ...) to a background [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`) session. The calling agent pays only for the prompt and the final report; the DeepSeek
session does the reading, scanning, drafting, and verifying, and is followable live in the DSH
web GUI.

- [`.agents/mcp-deepseek/`](.agents/mcp-deepseek/README.md) — the MCP bridge itself: a
  zero-dependency stdio server (`server.cjs`) that speaks MCP to the calling client and ACP to a
  spawned `dsh --profile acp` process.
- [`.agents/skills/deepseek-offload/`](.agents/skills/deepseek-offload/SKILL.md) — the full skill
  doc: when to offload, both delegation paths (blocking MCP tools vs. fire-and-forget background
  jobs via `scripts/dsh-offload.mjs`), forwarding your own MCP servers into the child session,
  prompt contracts, safety rules, and troubleshooting.

## Requirements

- Node.js (no npm dependencies — the bridge and job runner are plain CommonJS/ESM).
- A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) checkout with the `acp`
  profile initialized (`pnpm dsh --profile acp --dump-config`).
- An MCP client that can spawn local stdio servers (Claude Code, Antigravity/Gemini CLI, Codex
  CLI). Web-only clients (e.g. ChatGPT web) can't reach a local stdio server.

## Quick start

Register the bridge in your MCP client's config (Claude Code `.mcp.json`, Gemini
`mcp_config.json`, or `codex mcp add`):

```json
{
  "mcpServers": {
    "deepseek": {
      "command": "node",
      "args": ["/absolute/path/to/.agents/mcp-deepseek/server.cjs"],
      "env": { "DEEPSEEK_MCP_PERMISSION": "allow" }
    }
  }
}
```

Then see [`.agents/skills/deepseek-offload/SKILL.md`](.agents/skills/deepseek-offload/SKILL.md)
for the full usage guide.
