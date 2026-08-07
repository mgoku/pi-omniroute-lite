# Development

This package is meant to be developed **away from your live pi setup**. The
extension reads and writes `~/.pi/agent/models.json` and is auto-loaded from
`~/.pi/agent/extensions/` on every session start, so editing those directly is
risky. Use the workflow below instead.

## 1. Clone to a dev location (not pi's private dir)

```bash
git clone git@github.com:mgoku/pi-omniroute-lite.git ~/dev/pi-omniroute-lite
cd ~/dev/pi-omniroute-lite
npm install
```

## 2. Edit and typecheck

```bash
npm run typecheck
```

Typecheck validates `extensions/omniroute.ts` against pi's real types
(`@earendil-works/pi-coding-agent` is a peer dependency).

## 3. Run in an isolated pi session

```bash
npm run dev
```

`npm run dev` does two things to keep your live setup safe:

- `--no-extensions` disables pi's auto-discovery, so the **live** copy in
  `~/.pi/agent/extensions/omniroute.ts` is NOT loaded. Only this repo's
  `extensions/omniroute.ts` runs (no duplicate `/omniroute-setup` registration).
- `PI_HOME=./.pi-dev-home` redirects the extension's `models.json`
  reads/writes into a throwaway sandbox inside the repo, so your real
  `~/.pi/agent/models.json` is untouched.

You can pass extra args through to pi, e.g. `npm run dev -- --help`.

The sandbox dir (`.pi-dev-home/`) is git-ignored.

## 4. Deploy to your real pi (only when ready)

```bash
npm run install-ext   # copies extensions/omniroute.ts -> ~/.pi/agent/extensions/
```

Then restart pi or run `/reload`. To verify the live install:

```bash
pi install npm:pi-omniroute-lite   # or re-run install-ext after changes
```

## Safety rules

- **Never edit `~/.pi/agent/extensions/omniroute.ts` directly** — it is a
  generated artifact. Edit the repo, then `install-ext`.
- **Don't run `/omniroute-setup` or `/omniroute-sync`** from a half-baked
  build against your real `models.json` unless you intend to.

## Releasing

1. Commit and push your changes.
2. Bump `version` in `package.json`.
3. Publish (deferred for now): `npm publish --access public`.
   After that, users install with `pi install npm:pi-omniroute-lite`.
