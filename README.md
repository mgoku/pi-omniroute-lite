# pi-omniroute-lite

A minimal [pi](https://pi.dev) extension that connects a local
[OmniRoute](https://github.com/mgoku/omniroute) gateway to pi as a plain
OpenAI-compatible provider.

## Features

- `/omniroute-setup` — prompt for base URL + API key, write the provider block.
- `/omniroute-sync` — pull `/v1/models` into the Ctrl+P model picker.
- Status-bar indicator `OmniRoute ✓ / ✗` (with the active model id) shown on
  session start, refreshed every 60s, and updated on model switch.
- **Upstream metadata enrichment** — OmniRoute reports generic/wrong metadata
  for some providers (e.g. every `nous/*` model gets `context_length: 128000`,
  no max output tokens, no effort tiers, no input modalities). During sync,
  rows whose id starts with a known provider prefix are patched from that
  provider's own `/v1/models` endpoint. Built-in: `nous` →
  `https://inference-api.nousresearch.com/v1/models`. Best-effort: an
  unreachable upstream leaves gateway data untouched. The provider list is
  configurable — see [Upstream providers](#upstream-providers).
- **Reasoning effort per model** — sync stamps a pi `thinkingLevelMap` so the
  thinking-level selector only offers levels a model accepts (pi never sends an
  invalid `reasoning_effort`, e.g. `high` on qwen3.8-max → 400). Source order:
  1. the gateway's per-model `capabilities.effort_tiers` from `/v1/models`,
  2. pi's built-in provider catalogs (`@earendil-works/pi-ai`, alias prefix
     stripped — covers e.g. qwen3.8-max → `low/medium/xhigh`), 3. otherwise
  nothing, and pi's default `off/low/medium/high` applies.
- **Catalog metadata backfill (case 1)** — when a model's gateway row has no
  usable `contextWindow` / `maxTokens` (upstream didn't provide it, or reported
  an implausible/zero value), sync fills those fields — plus `input` modalities
  and `thinkingLevelMap` — from pi's own built-in provider catalogs. This is
  the exact same source pi trusts for its own providers, so popular models get
  sane values with no extra config and no network call. A plausible gateway
  value always wins over the catalog; the catalog only fills gaps. Manual
  overrides (below) win over both.
- **Manual model overrides (case 3)** — instead of editing the extension to fix
  a model, add an `overrides` map to `~/.pi/agent/omniroute-upstreams.json`
  keyed by model id (see below). User overrides merge over the built-in
  defaults and win over both the gateway value and the catalog backfill.
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

## Upstream providers

When OmniRoute reports wrong metadata for a provider, sync can patch those
models from the provider's own `/v1/models` endpoint. The built-in list ships
with `nous`; add or override providers in
`~/.pi/agent/omniroute-upstreams.json` (next to `models.json`, honors
`PI_HOME`). The file is re-read on every `/omniroute-sync` — no restart
needed.

```json
{
  "providers": [
    {
      "prefix": "acme",
      "url": "https://api.acme.ai/v1/models",
      "extract": "openrouter",
      "apiKey": "sk-..."
    },
    { "prefix": "nous", "disabled": true }
  ]
}
```

- `prefix` — gateway model-id prefix (`acme` matches `acme/<model>`).
- `url` — the provider's `/v1/models` endpoint.
- `extract` — row shape: `openrouter` (top_provider / architecture / reasoning
  fields, the default) or `openai` (flat context_length / max_output_tokens).
- `apiKey` — optional Bearer token for providers that gate `/v1/models`.
- `disabled: true` — removes a prefix, including built-ins.

A malformed file falls back to the built-ins and shows a warning after sync.

### Model overrides

For models where OmniRoute reports wrong `contextWindow`/`maxTokens` and neither
upstream enrichment nor the pi-ai catalog backfill covers them (case 3), add an
`overrides` map to the same `omniroute-upstreams.json` — no extension edit or
rebuild needed. Keys are gateway model ids; each value may set `contextWindow`
and/or `maxTokens`. User entries merge over the built-in defaults and win over
both the gateway value and the catalog backfill.

```json
{
  "providers": [
    { "prefix": "nous", "disabled": true }
  ],
  "overrides": {
    "oc/deepseek-v4-flash-free": { "contextWindow": 200000, "maxTokens": 131072 }
  }
}
```

- `overrides` — optional map of `modelId → { contextWindow?, maxTokens? }`.
  Values must be positive numbers to be applied; built-in `MODEL_OVERRIDES` are
  kept for any id not present here.

## Develop

```bash
npm run typecheck    # type-check omniroute.ts against pi's types
```

The extension is plain TypeScript (no runtime dependencies — TypeScript is a
dev dependency).

## License

MIT
