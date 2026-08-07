# pi-omniroute-lite

A minimal, dependency-free [pi](https://pi.dev) extension that connects a local
[OmniRoute](https://github.com/mgoku/omniroute) gateway to pi as a plain
OpenAI-compatible provider.

It replaces the upstream `omniroute-pi-ext-integration` package, which stamps a
fake `api: "omni-prompt-tools"` into `~/.pi/agent/models.json` and breaks
`fetch_content` **answer mode** ("No API provider registered"). This extension
only ever writes the real `api: "openai-completions"`, and makes sure every
synced model carries a `cost` object (pi-core throws on `model.cost.tiers`
otherwise).

## Features

- `/omniroute-setup` — prompt for base URL + API key, write the provider block.
- `/omniroute-sync` — pull `/v1/models` into the Ctrl+P model picker.
- Status-bar indicator `OmniRoute ✓ / ✗` (with the active model id) shown on
  session start, refreshed every 60s, and updated on model switch.
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

The extension is plain TypeScript; pi loads `*.ts` directly from
`~/.pi/agent/extensions/`, so no build step is required.

## License

MIT
