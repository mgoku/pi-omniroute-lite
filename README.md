# pi-omniroute-lite

A minimal [pi](https://pi.dev) extension that connects a local
[OmniRoute](https://github.com/mgoku/omniroute) gateway to pi as a plain
OpenAI-compatible provider.

## Features

- `/omniroute-setup` — prompt for base URL + API key, write the provider block.
- `/omniroute-sync` — pull `/v1/models` into the Ctrl+P model picker.
- Status-bar indicator `OmniRoute ✓ / ✗` (with the active model id) shown on
  session start, refreshed every 60s, and updated on model switch.
- **Reasoning effort per model** — sync stamps a pi `thinkingLevelMap` so the
  thinking-level selector only offers levels a model accepts (pi never sends an
  invalid `reasoning_effort`, e.g. `high` on qwen3.8-max → 400). Source order:
  1. the gateway's per-model `capabilities.effort_tiers` from `/v1/models`,
  2. pi's built-in provider catalogs (`@earendil-works/pi-ai`, alias prefix
     stripped — covers e.g. qwen3.8-max → `low/medium/xhigh`), 3. otherwise
  nothing, and pi's default `off/low/medium/high` applies.
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
