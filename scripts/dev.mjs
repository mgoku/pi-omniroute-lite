#!/usr/bin/env node
/**
 * Safe local dev runner for pi-omniroute-lite.
 *
 * Runs the extension in a throwaway pi session so development never touches
 * your real setup. pi resolves its config dir as $HOME/.pi/agent (it does NOT
 * read PI_HOME itself), and this extension's models.json path honors PI_HOME
 * when set, so we point BOTH at a sandbox:
 *   - Overriding HOME makes pi load/store everything under
 *     ./.pi-dev-home/.pi/agent instead of ~/.pi/agent, so the live
 *     models.json and the live auto-discovered extension are untouched.
 *   - --no-extensions disables pi's extension auto-discovery, so even if the
 *     sandbox ever contained a copy it would not double-load. Only this
 *     repo's extensions/omniroute.ts (via -e) runs.
 *
 * Pass extra args through to pi, e.g. `npm run dev -- --help`.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = join(root, ".pi-dev-home");
mkdirSync(sandbox, { recursive: true });

const ext = resolve(root, "extensions", "omniroute.ts");
if (!existsSync(ext)) {
	console.error(`✖ extension not found at ${ext}`);
	process.exit(1);
}

const extra = process.argv.slice(2);
const result = spawnSync(
	"pi",
	["--no-extensions", "-e", ext, ...extra],
	{
		stdio: "inherit",
		// HOME drives where pi puts ~/.pi/agent; PI_HOME is also honored by the
		// extension's own models.json lookup. Both point at the sandbox.
		env: { ...process.env, HOME: sandbox, PI_HOME: sandbox },
	},
);

if (result.error) {
	console.error(`✖ failed to run pi: ${result.error.message}`);
	if (result.error.code === "ENOENT") {
		console.error(
			"  pi is not installed or not on PATH. Install it from https://pi.dev",
		);
	}
	process.exit(1);
}

process.exit(result.status ?? 1);
