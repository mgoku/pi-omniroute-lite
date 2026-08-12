/**
 * pi-omniroute-lite — minimal Local OmniRoute integration for pi
 *
 * Registers your local OmniRoute gateway (http://localhost:20129/v1, or any
 * URL you set) as a plain OpenAI-compatible provider in ~/.pi/agent/models.json
 * using the real `api: "openai-completions"` so every pi path — chat, tools,
 * and fetch_content answer mode — resolves cleanly.
 *
 * Commands:
 *   /omniroute-setup   Save base URL + API key, write the provider block
 *   /omniroute-sync    Pull /v1/models and refresh the model list
 *
 * A status-bar indicator (OmniRoute ✓/✗) is shown automatically on session
 * start and refreshed every 60s, and updated when you switch models.
 *
 * Why this exists instead of the upstream `omniroute-pi-ext-integration`:
 * that extension stamps a fake `api: "omni-prompt-tools"` (not a registered
 * pi-core handler), which makes fetch_content answer mode throw
 * "No API provider registered". This extension only ever writes the real
 * `api: "openai-completions"`, and ensures every synced model has a `cost`
 * object (pi-core throws on `model.cost.tiers` when cost is missing).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "omni";
const DEFAULT_BASE_URL = "http://localhost:20129/v1";
const API = "openai-completions"; // real pi-core handler; fixes answer-mode crash
const STATUS_KEY = "omni";
const HEALTH_INTERVAL_MS = 60_000; // re-check every 60s while session is alive

let cachedModelsJsonPath: string | undefined;

function modelsJsonPath(): string {
	// Only the positive result is cached: once ~/.pi/agent/models.json exists it
	// won't stop existing, but the fallback must stay re-checkable so a file
	// created mid-session (fresh install, pi migration) is still picked up.
	if (cachedModelsJsonPath) return cachedModelsJsonPath;
	const fs = require("node:fs");
	const os = require("node:os");
	const path = require("node:path");
	const home = process.env.PI_HOME ?? os.homedir();
	const candidate = path.join(home, ".pi", "agent", "models.json");
	if (fs.existsSync(candidate)) {
		cachedModelsJsonPath = candidate;
		return candidate;
	}
	return path.join(home, ".pi", "models.json");
}

function readModelsJson(): any {
	const fs = require("node:fs");
	try {
		return JSON.parse(fs.readFileSync(modelsJsonPath(), "utf8"));
	} catch {
		return {};
	}
}

function writeModelsJson(config: any): void {
	const fs = require("node:fs");
	fs.writeFileSync(modelsJsonPath(), JSON.stringify(config, null, 2));
}

/** The stored apiKey, with the keyless "dummy" sentinel normalized to "". */
function realApiKey(provider: any): string {
	const key = provider?.apiKey ?? "";
	return key && key !== "dummy" ? key : "";
}

async function checkHealth(baseUrl: string, apiKey: string): Promise<boolean> {
	try {
		const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/models`, {
			headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
			signal: AbortSignal.timeout(5000),
		});
		// We only need the status. Discarding the (~15KB) body releases the socket
		// back to the pool instead of letting it idle until GC — ~3x faster per
		// probe, and this runs every 60s for the whole session.
		void res.body?.cancel().catch(() => {});
		return res.ok;
	} catch {
		return false;
	}
}

/**
 * OmniRoute's /v1/models returns wrong context/max-token values for some models.
 * These overrides stamp the correct values during sync. Keyed by model id.
 * contextWindow = total context; maxTokens = max output tokens.
 */
const MODEL_OVERRIDES: Record<string, { contextWindow?: number; maxTokens?: number }> = {
	"oc/deepseek-v4-flash-free": { contextWindow: 200000, maxTokens: 131072 },
};

/** Convert OmniRoute /v1/models rows into pi models.json model entries. */
function toModels(data: any[]): any[] {
	const out: any[] = [];
	for (const m of data) {
		const id = typeof m === "string" ? m : m.id;
		if (!id) continue;

		const entry: any = {
			id,
			input: Array.isArray(m.input_modalities)
				? m.input_modalities
				: Array.isArray(m.input)
					? m.input
					: ["text"],
		};

		// Preserve a friendly name when available.
		const name =
			typeof m === "object" ? (m.name ?? m.root ?? m.id) : id;
		if (name && name !== id) entry.name = name;

		const ctx = m.context_length ?? m.max_input_tokens;
		if (ctx) entry.contextWindow = ctx;

		const maxOut = m.max_output_tokens ?? m.max_tokens;
		if (maxOut) entry.maxTokens = maxOut;

		// pi's model override path reads model.cost.tiers; a missing cost object
		// throws "Cannot read properties of undefined (reading 'tiers')".
		entry.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

		if (m.capabilities?.tool_calling === false) entry.tool_calling = false;
		if (m.capabilities?.reasoning || m.capabilities?.thinking) entry.reasoning = true;

		// Apply known-correct values for models where OmniRoute reports bad data.
		const override = MODEL_OVERRIDES[id];
		if (override) {
			if (override.contextWindow !== undefined)
				entry.contextWindow = override.contextWindow;
			if (override.maxTokens !== undefined) entry.maxTokens = override.maxTokens;
		}

		out.push(entry);
	}
	// Stable order: by id for a clean Ctrl+P list.
	return out.sort((a, b) => a.id.localeCompare(b.id));
}

let healthInterval: ReturnType<typeof setInterval> | undefined;
/** Last known health, so suffix-only updates can repaint without a network probe. */
let lastHealthy: boolean | undefined;
/** Active omni model id, remembered so the 60s refresh doesn't wipe the suffix. */
let activeOmniModelId: string | undefined;

function setStatus(ctx: any, text: string | undefined) {
	try {
		ctx.ui.setStatus(STATUS_KEY, text);
	} catch {
		/* ui may be unavailable during early startup */
	}
}

/** Paint the status bar from already-known state. Never touches the network. */
function renderStatus(ctx: any): void {
	if (lastHealthy === undefined) return;
	const suffix = activeOmniModelId ? ` → ${activeOmniModelId}` : "";
	setStatus(ctx, lastHealthy ? `OmniRoute ✓${suffix}` : `OmniRoute ✗${suffix}`);
}

/**
 * Probe OmniRoute and show health in the status bar.
 * - Unconfigured: no 'omni' provider yet
 * - ✓ healthy, ✗ unreachable
 * - When an omni model is active, append the model id
 *
 * Callers must NOT await this on an event path: pi awaits extension handlers
 * serially, so a blocked probe stalls the UI for the full 5s timeout.
 */
async function refreshStatus(ctx: any): Promise<void> {
	const provider = readModelsJson().providers?.[PROVIDER_ID];
	if (!provider?.baseUrl) {
		lastHealthy = undefined;
		setStatus(ctx, undefined);
		return;
	}
	lastHealthy = await checkHealth(provider.baseUrl, realApiKey(provider));
	renderStatus(ctx);
}

export default function omnirouteExtension(pi: ExtensionAPI) {
	// Status-bar health check on every session start (startup, reload, resume, fork).
	pi.on("session_start", async (_event, ctx) => {
		// Headless modes get a no-op setStatus, so probing would burn up to 5s of
		// startup (and a 60s interval for the session lifetime) painting nothing.
		if (ctx.mode !== "tui") return;
		// Deliberately not awaited: pi awaits session_start handlers, and an
		// unreachable gateway would otherwise delay startup by the full timeout.
		void refreshStatus(ctx);
		if (healthInterval) clearInterval(healthInterval);
		healthInterval = setInterval(() => void refreshStatus(ctx), HEALTH_INTERVAL_MS);
		healthInterval.unref?.();
	});

	pi.on("session_shutdown", async () => {
		if (healthInterval) {
			clearInterval(healthInterval);
			healthInterval = undefined;
		}
	});

	// Reflect the active omni model id once selected.
	pi.on("model_select", async (event, ctx) => {
		if (ctx.mode !== "tui") return; // no status bar to update
		const isOmni = event.model?.provider === PROVIDER_ID;
		const wasOmni = activeOmniModelId !== undefined;
		// Switching between two non-omni models changes nothing we display.
		if (!isOmni && !wasOmni) return;
		activeOmniModelId = isOmni ? event.model?.id : undefined;
		// Repaint instantly from cached health, then re-probe in the background.
		// Awaiting the probe here would freeze every model switch (up to 5s when
		// the gateway is unreachable) because pi awaits this handler.
		renderStatus(ctx);
		void refreshStatus(ctx);
	});

	pi.registerCommand("omniroute-setup", {
		description: "Omniroute: save base URL + API key, create provider in models.json",
		handler: async (_args, ctx) => {
			const urlInput = await ctx.ui.input(
				"OmniRoute Base URL",
				`e.g. ${DEFAULT_BASE_URL}`,
			);
			if (urlInput === undefined || !urlInput.trim()) return;
			const baseUrl = urlInput.trim().replace(/\/+$/, "");

			const keyInput = await ctx.ui.input(
				"OmniRoute API Key",
				"Enter API key, or leave blank for keyless",
			);
			if (keyInput === undefined) return;
			const apiKey = keyInput.trim();

			const healthy = await checkHealth(baseUrl, apiKey);
			if (!healthy) {
				ctx.ui.notify(
					`⚠️ OmniRoute unreachable at ${baseUrl}. Saved anyway — check the server and run /omniroute-sync.`,
					"warning",
				);
			}

			const config = readModelsJson();
			config.providers ??= {};
			config.providers[PROVIDER_ID] = {
				baseUrl,
				api: API,
				apiKey: apiKey || "dummy",
				models: config.providers[PROVIDER_ID]?.models ?? [],
			};
			writeModelsJson(config);
			lastHealthy = healthy;
			renderStatus(ctx);

			ctx.ui.notify(
				`✅ Saved '${PROVIDER_ID}' provider (${baseUrl}) with api: ${API}.\n` +
					`Run /omniroute-sync to pull models.${healthy ? "" : " Server was unreachable just now."}`,
				"info",
			);
		},
	});

	pi.registerCommand("omniroute-sync", {
		description: "Omniroute: pull /v1/models into Ctrl+P picker",
		handler: async (_args, ctx) => {
			// Read the config exactly once. Three separate reads could observe three
			// different on-disk states, and the same object is reused for the write.
			const config = readModelsJson();
			const baseUrl = config.providers?.[PROVIDER_ID]?.baseUrl ?? DEFAULT_BASE_URL;
			const apiKey = realApiKey(config.providers?.[PROVIDER_ID]);

			if (!baseUrl) {
				ctx.ui.notify("No 'omni' provider found. Run /omniroute-setup first.", "error");
				return;
			}

			ctx.ui.notify("Syncing models from OmniRoute...", "info");

			let data: any[];
			try {
				const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/models`, {
					headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
					signal: AbortSignal.timeout(10000),
				});
				if (!res.ok) {
					ctx.ui.notify(`Sync failed: OmniRoute returned ${res.status}`, "error");
					return;
				}
				const json = await res.json();
				data = Array.isArray(json?.data) ? json.data : [];
			} catch (e: any) {
				ctx.ui.notify(`Sync failed: ${e?.message ?? e}`, "error");
				return;
			}

			const models = toModels(data);
			config.providers ??= {};
			config.providers[PROVIDER_ID] = {
				baseUrl,
				api: API,
				apiKey: apiKey || "dummy",
				models,
			};
			writeModelsJson(config);

			try {
				ctx.modelRegistry.refresh();
			} catch {
				/* refresh best-effort; reload picks it up */
			}

			ctx.ui.notify(
				`✅ Synced ${models.length} models to Ctrl+P (api: ${API}).`,
				"info",
			);
		},
	});
}
