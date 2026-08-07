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
const API = "openai-completions"; // real pi-core handler; fixes answer-mode crash
const STATUS_KEY = "omni";
const HEALTH_INTERVAL_MS = 60_000; // re-check every 60s while session is alive

function modelsJsonPath(): string {
	const fs = require("node:fs");
	const os = require("node:os");
	const path = require("node:path");
	const home = process.env.PI_HOME ?? os.homedir();
	const candidate = path.join(home, ".pi", "agent", "models.json");
	return fs.existsSync(candidate) ? candidate : path.join(home, ".pi", "models.json");
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

function getOmniUrl(): string {
	return readModelsJson()?.providers?.[PROVIDER_ID]?.baseUrl ?? "http://localhost:20129/v1";
}

function getApiKey(): string {
	return readModelsJson()?.providers?.[PROVIDER_ID]?.apiKey ?? "";
}

async function checkHealth(baseUrl: string, apiKey: string): Promise<boolean> {
	try {
		const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/models`, {
			headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
			signal: AbortSignal.timeout(5000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

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

		out.push(entry);
	}
	// Stable order: by id for a clean Ctrl+P list.
	return out.sort((a, b) => a.id.localeCompare(b.id));
}

let healthInterval: ReturnType<typeof setInterval> | undefined;

function setStatus(ctx: any, text: string | undefined) {
	try {
		ctx.ui.setStatus(STATUS_KEY, text);
	} catch {
		/* ui may be unavailable during early startup */
	}
}

/**
 * Show OmniRoute health in the status bar.
 * - Unconfigured: no 'omni' provider yet
 * - ✓ healthy, ❌ unreachable
 * - When an omni model is active, append the model id
 */
async function refreshStatus(ctx: any, activeModelId?: string): Promise<void> {
	const config = readModelsJson();
	const provider = config.providers?.[PROVIDER_ID];
	if (!provider?.baseUrl) {
		setStatus(ctx, undefined);
		return;
	}
	const healthy = await checkHealth(provider.baseUrl, provider.apiKey && provider.apiKey !== "dummy" ? provider.apiKey : "");
	const suffix = activeModelId ? ` → ${activeModelId}` : "";
	setStatus(ctx, healthy ? `OmniRoute ✓${suffix}` : `OmniRoute ✗${suffix}`);
}

export default function omnirouteExtension(pi: ExtensionAPI) {
	// Status-bar health check on every session start (startup, reload, resume, fork).
	pi.on("session_start", async (_event, ctx) => {
		await refreshStatus(ctx);
		if (healthInterval) clearInterval(healthInterval);
		healthInterval = setInterval(() => refreshStatus(ctx), HEALTH_INTERVAL_MS);
	});

	pi.on("session_shutdown", async () => {
		if (healthInterval) {
			clearInterval(healthInterval);
			healthInterval = undefined;
		}
	});

	// Reflect the active omni model id once selected.
	pi.on("model_select", async (event, ctx) => {
		const id = event.model?.id;
		await refreshStatus(ctx, id);
	});

	pi.registerCommand("omniroute-setup", {
		description: "Omniroute: save base URL + API key, create provider in models.json",
		handler: async (_args, ctx) => {
			const urlInput = await ctx.ui.input(
				"OmniRoute Base URL",
				"e.g. http://localhost:20129/v1",
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
			const baseUrl = getOmniUrl();
			const apiKey = getApiKey();

			if (!baseUrl) {
				ctx.ui.notify("No 'omni' provider found. Run /omniroute-setup first.", "error");
				return;
			}

			ctx.ui.notify("Syncing models from OmniRoute...", "info");

			let data: any[];
			try {
				const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/models`, {
					headers: apiKey && apiKey !== "dummy" ? { Authorization: `Bearer ${apiKey}` } : {},
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
			const config = readModelsJson();
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
