# Harness-side changes

Everything in this directory is a change to the **DeepSeek Harness** itself rather than to this
package. They are what makes the delegation end up visible and useful in the GUI, and none of them
touch the bridge: the bridge works without them, it just reports less and groups less.

`install.sh` applies all of this automatically (`--with-vision-subagent` for the optional part).
The files here are the source of truth, so the changes can be reviewed, re-applied after a Harness
update, or applied by hand on a machine where the installer cannot run.

| Change | File | Installer flag |
| --- | --- | --- |
| `acp` profile pins the delegation model | [`profiles/acp.cordis.patch.yml`](profiles/acp.cordis.patch.yml) | always |
| `acp` profile declares its model catalog | [`profiles/acp.cordis.patch.yml`](profiles/acp.cordis.patch.yml) | always |
| Web profile loads the workspace plugin | [`profiles/web.cordis.patch.yml`](profiles/web.cordis.patch.yml) | always |
| `read_image_vision` subagent in the `standard` preset | [`patches/standard-preset-read-image-vision.patch`](patches/standard-preset-read-image-vision.patch) | `--with-vision-subagent` |

## 1. The `acp` profile pins the model

Sessions the bridge creates run under the `acp` profile, so that profile — not the GUI's default —
decides which model a delegated job uses. Pin it explicitly, or a Harness upgrade can move every
job onto a different model without a line of this package changing.

`$DSH_HOME/profiles/acp/cordis.patch.yml`:

```yaml
- id: acp
  config:
    provider: deepseek-official
    model: deepseek-flash
```

Verify: `dsh --profile acp --dump-config` shows the `acp` row with that model. A model id the
provider does not know fails at the first turn with `The supported API model names are ...`, so a
job that dies instantly is usually this pin, not the bridge — change it with
`install.sh --model <id>` (or `DEEPSEEK_OFFLOAD_MODEL`) rather than editing the row by hand.

`deepseek-flash` is the name this route accepts; `deepseek-v4-pro` is the other one. The ids
`deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` still resolve but name retired models served
by DeepSeek-V4.1-Flash, so pin one only for compatibility with a route that has not moved on.

## 2. The `acp` profile declares its model catalog

The provider ships a catalog of model ids with the input each one accepts. **A profile patch replaces
that catalog**, and a model the catalog does not carry resolves as text-only, so an image job under
it is refused:

```
Error: cannot read "scan.png" as an image: model "deepseek-flash" does not declare image input
```

The provider's own catalog declares image input for `deepseek-v4-flash-vision-exp`, not for the
current `deepseek-flash`, so pinning the current id without this row silently costs image support —
the job still runs, it just cannot read a picture. `$DSH_HOME/profiles/acp/cordis.patch.yml`:

```yaml
- id: llm-deepseek
  config:
    models:
      - id: deepseek-flash
        name: DeepSeek-V4.1-Flash
        inputModalities: ['text', 'image']
      - id: deepseek-v4-pro
        name: DeepSeek-V4-Pro
        inputModalities: ['text']
```

Verify: `dsh --profile acp --dump-config` shows the `llm-deepseek` row with that list, and
`dsh-offload doctor` prints `ok  model accepts images`. Because the patch replaces rather than
extends the catalog, an id the file omits stops being selectable in that profile — where the
provider later adds a model, add it here too.

## 3. The web profile loads the workspace plugin

The GUI files sessions into projects through a durable account that only the GUI process writes,
so the plugin that updates it has to run **inside** the GUI — see
[../.agents/dsh-workspace-attach/README.md](../.agents/dsh-workspace-attach/README.md).

`$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: workspace-attach
      name: '/absolute/path/.agents/dsh-workspace-attach/index.js'
      config:
        intervalMs: 1000
```

The installer points this row at `$DSH_HOME/plugins/dsh-workspace-attach` instead of a project path,
so several projects can install from their own copy without fighting over the row, and the GUI keeps
grouping after this package moves or is deleted. That path is a copy of the plugin;
`--link-plugin` symlinks it instead, for work on the plugin itself. The `web` profile is
`patchReload: live`, which means an added row is picked up by a running GUI after a page refresh
(verified against a running instance); a profile that is `patchReload: startup` needs `dsh web`
restarted.

## 4. Optional: the `read_image_vision` subagent

A session whose model is text-only cannot read an image file. A `spawn`-backend subagent pinned to
a vision model fixes that without moving the parent session onto a vision model:

```sh
git -C <harness-checkout> apply /path/to/harness/patches/standard-preset-read-image-vision.patch
```

The patch inserts one row into
`packages/preset/agent-presets/presets/standard/agent.cordis.yml`. It is a source change, so it
must be re-applied after a Harness update; `install.sh --with-vision-subagent` applies the same row
idempotently (it detects the row by `toolName: read_image_vision`), which is the safer option on a
checkout you update often.

Why `spawn` and not `fork`: a fork inherits the parent's model, so it could not read the image
either. Why `maxDepth: 1`: the reader is a leaf and cannot delegate further.
