# dsh-workspace-attach

A DeepSeek Harness **web-profile plugin** that files sessions created by the ACP automation plane
into a Workspace named after the directory the agent ran in, so delegated jobs stop landing in the
GUI's **Ungrouped** bucket.

It is the GUI-side half of [the bridge](../mcp-deepseek/README.md).

## Why it exists

The sidebar renders one group per registered Workspace and drops every session no Workspace lists
into a trailing **Ungrouped** bucket. Membership is written only by the GUI's own `session.create`
and by the webhook plane, so a session created by another process — the `dsh --profile acp` child
the bridge spawns — is never accounted. The one-time bootstrap that grouped older history by `cwd`
runs once behind an `initialized` marker and never again.

The registry cannot be written from outside the GUI either: its durable state is authoritative in
memory, so an out-of-process writer is invisible to the running GUI and is overwritten by the GUI's
next Workspace mutation. The GUI process has to perform the attach, so the bridge asks it to.

## Protocol

The inbox defaults to `$DSH_HOME/workspace-attach` (`DSH_WORKSPACE_ATTACH_DIR` overrides it).

| File | Shape |
| :--- | :--- |
| `<sessionId>.request.json` | `{ v: 1, sessionId, path, title?, root?, jobId?, requestedBy?, requestedAt }` |
| `<sessionId>.result.json` | `{ v: 1, sessionId, ok, workspaceId?, path?, title?, created?, already?, rolledBack?, error?, at }` |
| `heartbeat.json` | `{ v: 1, plugin, pid, at, intervalMs, processed, failed }` |

For each request the plugin resolves or creates the Workspace for `path` (the registry titles it
after the directory's base name), attaches the session, writes the result, and removes the request.
The result is written **before** the request is removed, so a crash mid-adoption re-runs an
idempotent operation instead of losing the request. A workspace this call created is removed again
when the attach is refused, so a wrong path cannot litter the sidebar. `heartbeat.json` lets a
producer tell "GUI not running" apart from "plugin not loaded".

`WorkspaceEntity.attachSession` validates that the session's stored header `cwd` **is** the
workspace path, which is why the request's `path` is the directory the agent ran in: run a job from
the project root and it joins the project; run it from `scratch/` and it joins a `scratch`
workspace.

## Install

```sh
# once per Harness home, from the project that vendors this repository
./install.sh
```

The installer points the profile row at a stable `$DSH_HOME/plugins/dsh-workspace-attach` link, so
several projects can install from their own copy without competing for the row. By hand:

```yaml
- insert:
    - id: workspace-attach
      name: '/absolute/path/.agents/dsh-workspace-attach/index.js'
      config:
        intervalMs: 1000
```

The `web` profile is `patchReload: live`, so a row added while the GUI runs applies after a page
refresh — no restart needed. `dsh-offload doctor` reports whether the plugin is answering.

## Config and environment

| Setting | Default | Meaning |
| :--- | :--- | :--- |
| `enabled` / `DSH_WORKSPACE_ATTACH` | `true` | `DSH_WORKSPACE_ATTACH=0` disables the scan loop. |
| `dir` / `DSH_WORKSPACE_ATTACH_DIR` | `$DSH_HOME/workspace-attach` | Inbox directory. |
| `intervalMs` / `DSH_WORKSPACE_ATTACH_INTERVAL_MS` | `1000` | Scan interval. |
| `maxPerTick` | `25` | Requests handled per scan; the rest wait for the next tick. |
| `resultTtlMs` | 24 h | Age at which result files are pruned. |

The plugin reads the timer service through `ctx.get('timer')` and falls back to a fiber-owned
interval, so it also loads in a profile that does not mount a timer.

## Tests

```sh
node --test .agents/dsh-workspace-attach/tests/adopt.test.js .agents/dsh-workspace-attach/tests/inbox.test.js
```

Covers the adoption semantics (create, join, idempotent re-run, refused attach, rollback) against a
stub registry, and the inbox protocol (id validation, atomic writes, request validation, pruning,
directory precedence).
