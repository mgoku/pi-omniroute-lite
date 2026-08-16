# pi-omniroute-lite

A minimal [pi](https://pi.dev) extension that connects a local
[OmniRoute](https://github.com/mgoku/omniroute) gateway to pi as a plain
OpenAI-compatible provider.

## Features

- `/omniroute-setup` — prompt for base URL + API key, write the provider block.
- `/omniroute-sync` — pull `/v1/models` into the Ctrl+P model picker.
- Status-bar indicator `OmniRoute ✓ / ✗` (with the active model id) shown on
  session start, refreshed every 60s, and updated on model switch.
- **Reasoning effort per model** — sync reads the gateway's per-model
  `capabilities.effort_tiers` and stamps a matching pi `thinkingLevelMap`, so
  the thinking-level selector only offers levels the model accepts (pi never
  sends an invalid `reasoning_effort`). Models whose gateway row omits tiers
  can be pinned via `THINKING_LEVEL_OVERRIDES` in `extensions/omniroute.ts`; it
  is pre-seeded for `charm-hyper/qwen3.8-max` and `trk/qwen/qwen3.8-max-free`,
  which only accept `low` / `medium` / `xhigh` and 400 on `high`.
- No third-party dependencies, no custom stream parser — uses pi-core's
  built-in OpenAI-compatible handler.

## Install

### Option A — pi package manager (recommended)

```bash
pi install npm:pi-omniroute-lite
```

pi discovers the `extensions/` directory automatically. Restart pi (or `/reload`).

### Option B — manual clone

```bash
git clone https://github.com/mgoku/pi-omniroute-lite.git
cd pi-omniroute-lite
npm install            # dev deps (typescript) for type-checking
npm run install-ext    # copies extensions/omniroute.ts -> ~/.pi/agent/extensions/
```

Restart pi (or `/reload`), then:

1. `/omniroute-setup` — defaults to `http://localhost:20129/v1`.
2. `/omniroute-sync` — pulls the model list.
3. Verify `/model` shows your OmniRoute models and that
   `fetch_content({ mode: "answer", ... })` works.

## Develop

```bash
npm run typecheck    # type-check omniroute.ts against pi's types
```

The extension is plain TypeScript (no runtime dependencies — TypeScript is a
dev dependency).

## License

MIT
