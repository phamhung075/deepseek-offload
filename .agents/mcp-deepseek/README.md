# deepseek-mcp — MCP bridge to a DeepSeek Harness agent

A zero-dependency **MCP stdio server** that lets any MCP-capable client (Claude Code,
Antigravity/Gemini CLI, Codex CLI, ...) delegate work to a **DeepSeek Harness** agent and read the
result from the shared session store — in the DeepSeek web GUI's session list, or live through
`../skills/deepseek-offload/scripts/session-tail.mjs`.

Register it in your client's MCP config (`install.sh --with-mcp-config` writes both shapes):

```json
{ "mcpServers": { "deepseek": {
    "command": "node",
    "args": ["/absolute/path/.agents/mcp-deepseek/server.cjs"],
    "env": { "DEEPSEEK_MCP_DEFAULT_CWD": "/absolute/path/to/your-project" } } } }
```

Nothing here needs the Harness source: the bridge runs an installed `dsh` when it finds one, and
falls back to a source checkout at `$DSH_ROOT` (default `~/deepseek-harness`).

## How it works

```
MCP client (Claude Code / Antigravity / Codex)
        │  MCP over stdio (JSON-RPC 2.0, NDJSON)
        ▼
  server.cjs  (this bridge)
        │  spawns `dsh --profile acp`
        │  ACP over stdio (JSON-RPC 2.0, NDJSON)
        ▼
  DeepSeek Harness agent  ── persists session ──►  ~/.dsh/sessions/…  ◄── web GUI reads
```

The bridge uses the **same `DSH_HOME` as the web GUI** (`~/.dsh`), so every session it creates
lands in the shared session store and shows up in the web GUI's session list (with its `cwd` set to
the workspace it ran in). Each result also reports a `Workspace:` line saying whether the GUI filed
that session under its project folder or left it Ungrouped, and why — see
[the plugin](../dsh-workspace-attach/README.md).

The GUI lists that session cold: it cannot show it **running** while the job works, and it cannot
stream a transcript the job is still appending to. Both need
`../skills/deepseek-offload/scripts/session-tail.mjs <jobId> --watch`.

## Tools exposed to Antigravity

| Tool | What it does |
| :--- | :--- |
| `deepseek_agent(prompt, cwd?, mcpConfig?)` | Runs one DeepSeek task in a fresh session; returns the final answer + session id. |
| `deepseek_list_sessions(cwd?)` | Lists DeepSeek sessions from the shared store. |
| `deepseek_mcp_servers(mcpConfig?)` | Resolves which MCP servers a delegation would receive, without running an agent. |
| `deepseek_update_session(sessionId, message?)` | Steers or cancels a session that's still mid-turn in this bridge process: interrupts it (`session/cancel`), then re-prompts the same session with `message` if given (preserving history), or — if `message` is omitted — closes the session normally with no redirect (`stopReason=cancelled`). Errors if the session already finished. |

## Forwarding MCP servers to the DeepSeek agent

The bridge can mount MCP servers **into the DeepSeek session**, so the child agent
gets the same tools the calling client has. The source is the caller's own
client-shaped config (Claude Code `.mcp.json` or Gemini `mcp_config.json`); nothing
else needs to be maintained.

```jsonc
// .mcp.json — read by Claude Code AND forwarded to DeepSeek
{ "mcpServers": {
    "docs": { "type": "http", "url": "https://mcp.example.com/mcp",
              "headers": { "Authorization": "Bearer ${DOCS_API_KEY}" } },
    "repo": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-git"] } } }
```

A tool on one of those servers reaches the child model as
`mcp__<serverName>__<toolName>` — e.g. `mcp__docs__search_documents`, `mcp__repo__log`.

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

1. Register the bridge in your client's MCP config — for Antigravity CLI a
   workspace-local `.agents/mcp_config.json` (or
   `~/.gemini/config/mcp_config.json`), for Claude Code `.mcp.json`. `install.sh
   --with-mcp-config` writes both.
2. The `acp` DSH profile must exist once: run
   `dsh --profile acp --dump-config` (idempotent; it auto-initializes
   `$DSH_HOME/profiles/acp`). From a Harness **source** checkout the launcher is
   `pnpm dsh --profile acp --dump-config`, which is what the bridge uses when no
   `dsh` is on `PATH`.
3. In Antigravity CLI, open the MCP manager (`/mcp`) and confirm the `deepseek`
   server shows as connected, then ask Gemini to "use the deepseek_agent tool".

## Configuration (env vars)

| Var | Default | Meaning |
| :--- | :--- | :--- |
| `DSH_BIN` | — | Explicit `dsh` executable for the ACP child; overrides PATH lookup and `DSH_ROOT` |
| `DSH_ROOT` | `~/deepseek-harness` | Harness **source** checkout, used when no `dsh` is on `PATH` |
| `DSH_HOME` | `~/.dsh` | Must match the web GUI's home so sessions are shared |
| `DEEPSEEK_MCP_DEFAULT_CWD` | the bridge process cwd | Default working directory for delegated sessions |
| `DEEPSEEK_MCP_PERMISSION` | `allow` | `allow` auto-accepts tool permission prompts; `reject` denies them |
| `DEEPSEEK_MCP_TIMEOUT_MS` | `900000` | Prompt timeout |
| `DEEPSEEK_MCP_CONFIG` | *(unset)* | Default client-shaped MCP config forwarded into every session |
| `DEEPSEEK_MCP_SKIP` | `deepseek` | Comma-separated server names never forwarded |

## Choosing the DeepSeek model

The route accepts `deepseek-flash` (vision-capable, and the id this installer pins) and
`deepseek-v4-pro`. The older ids `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are still
accepted, but they name retired models served by DeepSeek-V4.1-Flash, so a new install should not
pin them. The pin lives in `~/.dsh/profiles/acp/cordis.patch.yml`:

```yaml
- id: acp
  config:
    provider: deepseek-official
    model: deepseek-flash
```

Verify the pin with `pnpm dsh --profile acp --dump-config` (look for the `acp`
entry patched by `cordis.patch.yml`), or `dsh-offload doctor`.

## Notes / limits

- Stdio only: works with **Antigravity CLI** (or the IDE's local connector),
  which runs on your machine. Antigravity 2.0's *cloud* agent cannot reach a
  local stdio server — for that, expose this bridge behind a remote MCP
  (Streamable HTTP) endpoint instead.
- One `dsh --profile acp` process is spawned per tool call (a few seconds of
  boot overhead). The session it creates is persisted, so its full transcript can
  be read after the run instead of re-running the work — from the web GUI's
  session list (cold, with no live progress while it runs) or live with
  `../skills/deepseek-offload/scripts/session-tail.mjs`.
