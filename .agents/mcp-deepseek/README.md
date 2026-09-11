# deepseek-mcp — Antigravity (Gemini) → DeepSeek bridge

A zero-dependency **MCP stdio server** that lets Google **Antigravity CLI** delegate
work to a **DeepSeek Harness** agent and watch the result in the DeepSeek web GUI.

> **Claude Code** also connects to this same bridge, through this repo's project-scoped
> [`.mcp.json`](../../.mcp.json), which registers `deepseek` beside `pdf2w` and resolves the
> bridge path via `${PROJECTS_ROOT}` (set in Claude Code's global `~/.claude/settings.json`
> `env` block). It is already trusted and active in this workspace as of 2026-09-11.

## How it works

```
Antigravity CLI (Gemini, MCP client)
        │  MCP over stdio (JSON-RPC 2.0, NDJSON)
        ▼
  server.cjs  (this bridge)
        │  spawns `dsh --profile acp`
        │  ACP over stdio (JSON-RPC 2.0, NDJSON)
        ▼
  DeepSeek Harness agent  ── persists session ──►  ~/.dsh/sessions/…  ◄── web GUI reads
```

The bridge uses the **same `DSH_HOME` as the web GUI** (`~/.dsh`), so every session
it creates lands in the shared session store and shows up in the web GUI's session
list (with its `cwd` set to the workspace).

## Tools exposed to Antigravity

| Tool | What it does |
| :--- | :--- |
| `deepseek_agent(prompt, cwd?, mcpConfig?)` | Runs one DeepSeek task in a fresh session; returns the final answer + session id. |
| `deepseek_list_sessions(cwd?)` | Lists DeepSeek sessions from the shared store. |
| `deepseek_mcp_servers(mcpConfig?)` | Resolves which MCP servers a delegation would receive, without running an agent. |

## Forwarding MCP servers to the DeepSeek agent

The bridge can mount MCP servers **into the DeepSeek session**, so the child agent
gets the same tools the calling client has. The source is the caller's own
client-shaped config (Claude Code `.mcp.json` or Gemini `mcp_config.json`); nothing
else needs to be maintained.

```jsonc
// .mcp.json — read by Claude Code AND forwarded to DeepSeek
{ "mcpServers": {
    "pdf2w": { "type": "http", "url": "https://app.pdf2w.com/mcp",
               "headers": { "Authorization": "Bearer ${PDF2W_API_KEY}" } } } }
```

Then tools reach the model as `mcp__pdf2w__extract_document`,
`mcp__pdf2w__get_service_health`, and so on.

Which config applies, in order: the `mcpConfig` tool argument, then
`DEEPSEEK_MCP_CONFIG`, then none (the default, `mcpServers: []`).

Translation rules, all fail-loud:

| Client entry | Forwarded as |
| :--- | :--- |
| `{command, args, env}` | ACP stdio declaration; a bare `command` is resolved against `PATH` to an absolute path (ACP requires one). |
| `{type: 'http', url, headers}` | ACP HTTP declaration. |
| `{type: 'sse', …}` | Rejected: only stdio and Streamable HTTP are supported. |
| `${VAR}` anywhere | Expanded from the bridge's environment; an unset variable aborts the call with the exact field path. |
| `cwd` | Ignored (warned): ACP fixes stdio servers to the session `cwd`. |
| Name `deepseek`, or args pointing back at this bridge | Skipped, so a DeepSeek agent can never delegate to itself. Override the name list with `DEEPSEEK_MCP_SKIP`. |

A server that fails to start aborts `session/new` — DSH reports this as a generic
`Internal error` with no server name, so run `deepseek_mcp_servers` (or
`dsh-offload mcp-servers`) first when a session refuses to start.

## Setup

1. The Antigravity CLI MCP config is already written at
   [`.agents/mcp_config.json`](../mcp_config.json) (Antigravity CLI reads the
   workspace-local `.agents/mcp_config.json`; it can also go in
   `~/.gemini/config/mcp_config.json`).
2. The `acp` DSH profile must exist once: run
   `cd ~/__projects__/deepseek-harness && pnpm dsh --profile acp --dump-config`
   (idempotent; it auto-initializes `~/.dsh/profiles/acp`).
3. In Antigravity CLI, open the MCP manager (`/mcp`) and confirm the `deepseek`
   server shows as connected, then ask Gemini to "use the deepseek_agent tool".

## Configuration (env vars)

| Var | Default | Meaning |
| :--- | :--- | :--- |
| `DSH_ROOT` | `~/__projects__/deepseek-harness` | DeepSeek Harness checkout (cwd for `dsh`) |
| `DSH_HOME` | `~/.dsh` | Must match the web GUI's home so sessions are shared |
| `DEEPSEEK_MCP_DEFAULT_CWD` | `~/__projects__/markdown-extract-service` | Default working dir for sessions |
| `DEEPSEEK_MCP_PERMISSION` | `allow` | `allow` auto-accepts tool permission prompts; `reject` denies them |
| `DEEPSEEK_MCP_TIMEOUT_MS` | `900000` | Prompt timeout |
| `DEEPSEEK_MCP_CONFIG` | *(unset)* | Default client-shaped MCP config forwarded into every session |
| `DEEPSEEK_MCP_SKIP` | `deepseek` | Comma-separated server names never forwarded |

## Choosing the DeepSeek model

The bundle default is `deepseek-v4-flash`; this workspace pins the vision-capable
model in `~/.dsh/profiles/acp/cordis.patch.yml`:

```yaml
- id: acp
  config:
    provider: deepseek-official
    model: deepseek-v4-flash-vision-exp
```

Verify the pin with `pnpm dsh --profile acp --dump-config` (look for the `acp`
entry patched by `cordis.patch.yml`), or `dsh-offload doctor`.

## Notes / limits

- Stdio only: works with **Antigravity CLI** (or the IDE's local connector),
  which runs on your machine. Antigravity 2.0's *cloud* agent cannot reach a
  local stdio server — for that, expose this bridge behind a remote MCP
  (Streamable HTTP) endpoint instead.
- One `dsh --profile acp` process is spawned per tool call (a few seconds of
  boot overhead). The session it creates is persisted, so you can always resume
  it in the web GUI rather than re-running.
