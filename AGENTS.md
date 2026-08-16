# AGENTS.md

Guidance for AI agents (and humans) working on **pi-omniroute-lite**.

## What this project is

A **minimal** [pi](https://pi.dev) extension that connects a local
[OmniRoute](https://github.com/mgoku/omniroute) gateway (default `http://localhost:20129/v1`)
to pi as a plain **OpenAI-compatible provider**.

**Core values (do not regress):**

- **Only ever write `api: "openai-completions"`** — the real pi-core handler. Never invent or
  introduce a different `api` string.
- **Every synced model must carry a `cost` object** — pi-core's model override path reads
  `model.cost.tiers` and throws `Cannot read properties of undefined (reading 'tiers')` when
  `cost` is missing. `toModels()` in `extensions/omniroute.ts` guarantees this; never remove it.
- **Raw TypeScript, no build step.** pi loads the extension's `.ts` source directly at runtime via
  jiti (auto-discovery watches `~/.pi/agent/extensions/*.ts`), so there is no compile or emit
  step — TypeScript is a dev dependency used for typechecking only. Don't add *runtime* npm
  dependencies: stick to Node built-ins (`node:fs`, `node:os`, `node:path`, global `fetch`,
  `AbortSignal`).
- **The repo's `extensions/omniroute.ts` is the only source of truth.** Anything under
  `~/.pi/agent/extensions/` (or any other `~/.pi` path) is a copied artifact, overwritten by
  `npm run install-ext` — never edit it directly.

## Repository layout

| Path | Role |
| --- | --- |
| `extensions/omniroute.ts` | **The entire extension** — commands, status bar, models.json I/O. All real logic lives here. |
| `scripts/install.mjs` | Copies `extensions/omniroute.ts` → `~/.pi/agent/extensions/` (the deploy step). |
| `scripts/dev.mjs` | Runs the extension in an isolated, sandboxed pi session (`npm run dev`). |
| `package.json` | Scripts (`typecheck`, `install-ext`, `dev`); `files` whitelist controls what ships. |
| `tsconfig.json` | Strict TS; includes only `extensions/omniroute.ts`. |
| `DEVELOPMENT.md` | Human-focused dev/deploy workflow (keep it consistent with this file). |
| `README.md` | User-facing docs + install instructions. |

The published package (`files` in `package.json`) ships only `extensions/`, `README.md`,
`LICENSE`. **If you add source files, add them to `files`** or they won't ship.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | **The only validation gate.** `tsc --noEmit -p tsconfig.json` against `extensions/omniroute.ts`. No test suite and no linter exist. |
| `npm run dev` | Spawn a sandboxed pi session running this repo's extension. Pass-through args: `npm run dev -- --help`. |
| `npm run install-ext` | Deploy: copy the extension into the live `~/.pi/agent/extensions/` directory. |

After any code change, run `npm run typecheck` before considering the work done.

## Safe development workflow (critical)

The extension reads and writes `~/.pi/agent/models.json` and is auto-loaded on every session
start — developing against a live pi setup is risky. **Always develop through the sandbox:**

1. Edit only files in this repo.
2. `npm run typecheck` to validate against pi's real types
   (`@earendil-works/pi-coding-agent` is the peer dep / dev dep).
3. `npm run dev` to test interactively. This script:
   - Sets `HOME` **and** `PI_HOME` to `.pi-dev-home/` (git-ignored), so all state lands in the
     sandbox, never the live `~/.pi/agent/`.
   - Passes `--no-extensions` so pi's auto-discovery is disabled — the live copy of
     `omniroute.ts` in `~/.pi/agent/extensions/` is NOT loaded, and only this repo's file runs.
4. Deploy only when ready: `npm run install-ext`, then restart pi or `/reload`.

### The HOME/PI_HOME subtlety (easy to get wrong)

pi itself resolves its config dir as `$HOME/.pi/agent` and **does not read `PI_HOME`**. This
extension's `modelsJsonPath()` **does** honor `PI_HOME` when set. `scripts/dev.mjs` therefore
sets **both** env vars to the sandbox — if you ever change that logic, both must still point at
the sandbox or the live `models.json` gets written.

### Safety rules

- **Never edit `~/.pi/agent/extensions/omniroute.ts`** — it is a copied artifact, overwritten
  by `npm run install-ext`. Edit the repo, then `install-ext`.
- **Never run `/omniroute-setup` or `/omniroute-sync` (or otherwise write `models.json`) from a
  half-baked build against your real pi setup.** Use `npm run dev`.
- Never write to or delete a user's real `~/.pi/agent/models.json` outside the sandbox workflow.

## How the extension works

- **Config location** — `modelsJsonPath()`: `$PI_HOME/.pi/agent/models.json` if it exists,
  else `$PI_HOME/.pi/models.json` (older pi layout), with `PI_HOME` defaulting to `os.homedir()`.
- **Provider block written to `models.json`** (provider id `"omni"`):
  ```json
  {
    "providers": {
      "omni": {
        "baseUrl": "http://localhost:20129/v1",
        "api": "openai-completions",
        "apiKey": "… or the sentinel \"dummy\" when keyless",
        "models": [ … ]
      }
    }
  }
  ```
  `"dummy"` is a deliberate keyless sentinel: health checks and syncs must treat it as "no key".
- **Model mapping (`toModels()`)** — converts OmniRoute `/v1/models` rows into pi model entries:
  `id`, `input` (modalities, defaulting to `["text"]`), optional `name`/`contextWindow`/
  `maxTokens`, **always** `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`,
  `tool_calling: false` only when explicitly disabled, `reasoning: true` when advertised.
  `thinkingLevelMap` is stamped from the gateway's `capabilities.effort_tiers` (a manual
  `THINKING_LEVEL_OVERRIDES` entry wins) so the thinking-level selector only offers efforts
  a model accepts — never send an invalid `reasoning_effort` like `high` on qwen3.8-max.
  Output is sorted by `id` for a clean Ctrl+P list.
- **Status bar** — `OmniRoute ✓ / ✗` via `ctx.ui.setStatus`, refreshed on `session_start`,
  every 60s (`HEALTH_INTERVAL_MS`), and on `model_select` (appends the active model id).
  `ui.setStatus` can throw during early startup — the try/catch is intentional. The interval is
  cleared on `session_shutdown`.
- **Health check** — `GET {base}/v1/models` with a 5s `AbortSignal.timeout`; non-OK or throw
  ⇒ unhealthy. `baseUrl` has trailing slashes stripped before concatenating `/v1/models`.
  **URL quirk:** the stored baseUrl is conventionally entered *with* the trailing `/v1`
  (`http://localhost:20129/v1`), and the code then appends `/v1/models` on top of it. Preserve
  this behavior — don't "normalize" the URL construction without testing against a real gateway.
- **Sync** — same fetch, 10s timeout, then `ctx.modelRegistry.refresh()` (best-effort, wrapped;
  pi reload picks it up if it fails).
- **Commands** — `/omniroute-setup` (prompt base URL + key, write provider) and
  `/omniroute-sync` (pull models into the Ctrl+P picker).

## The pi extension contract

`extensions/omniroute.ts` must keep the shape pi expects: a default-exported function receiving
`ExtensionAPI` (`export default function omnirouteExtension(pi: ExtensionAPI)`), using
`pi.on("session_start" | "session_shutdown" | "model_select")` for events and
`pi.registerCommand(name, { description, handler })` for slash commands. The `ctx` object is
untyped `any` throughout — that's expected, not a gap to "fix".

## Code conventions

- **Tabs for indentation** (the source uses tabs).
- **Runtime `require()` inside functions** for `node:fs`/`node:os`/`node:path` — do not
  "clean up" these into top-level imports; that is the established pattern.
- **Intentional `any`** on `models.json` and OmniRoute payloads (the schemas belong to pi and
  OmniRoute, not this package). Keep `strict: true` — type safety for *our* code, not third-party
  shapes.
- **Best-effort error handling**: non-critical paths (status bar, model registry refresh) use
  empty catches with `/* best-effort */` comments. Don't add noisy error surfacing there.
- Import only the `ExtensionAPI` type from `@earendil-works/pi-coding-agent`. Do not add runtime
  imports or new dependencies.
- Default `baseUrl` is `http://localhost:20129/v1` — kept in sync in both the constant
  (`getOmniUrl()`) and the `/omniroute-setup` prompt placeholder.

## Change checklist

When modifying behavior, check these in order:

1. **Never introduce a non-`openai-completions` `api` value**, and never drop the `cost` object
   from synced models. (See "Core values" above.)
2. Keep `extensions/omniroute.ts` the single source of truth; update `README.md` /
   `DEVELOPMENT.md` if user-facing behavior or the workflow changes.
3. If you change constants (`PROVIDER_ID`, `STATUS_KEY`, `API`, interval), update every
   reference — they're used across commands, status, and I/O paths.
4. If you change how `models.json` is located or written, re-verify the `dev.mjs` sandbox still
   isolates both `HOME` and `PI_HOME`.
5. Run `npm run typecheck` — it must pass with zero errors.
6. For interactive verification, run `npm run dev` and exercise `/omniroute-setup` and
   `/omniroute-sync` in the sandbox, then inspect the generated `.pi-dev-home/.pi/agent/models.json`.
7. Releasing (rare): bump `version` in `package.json`, then publish per `DEVELOPMENT.md`
   (currently deferred — no npm releases have been cut).
