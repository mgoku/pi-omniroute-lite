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
	const path = require("node:path");
	const file = modelsJsonPath();
	// Ensure the parent dir exists: on a fresh setup (or the older .pi/models.json
	// fallback layout) pi may not have created it yet, and writeFileSync would
	// otherwise throw ENOENT.
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(config, null, 2));
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
 * OmniRoute reports wrong/zero context or max-output values for some models.
 * These overrides stamp the correct values during sync. Keyed by model id.
 * contextWindow = total context; maxTokens = max output tokens.
 *
 * Kept as built-in defaults that match the gateway's real data, so the common
 * offenders work out of the box. User entries in omniroute-upstreams.json
 * (the "overrides" map, see loadModelOverrides) are merged over these and
 * win on ties — so fixing a model no longer requires editing + rebuilding the
 * extension. Anything here can be superseded or disabled from config.
 */
const MODEL_OVERRIDES: Record<string, { contextWindow?: number; maxTokens?: number }> = {
	"oc/deepseek-v4-flash-free": { contextWindow: 200000, maxTokens: 131072 },
};

/** A contextWindow / maxTokens value is usable only if a positive finite number. */
function plausibleWindow(v: unknown): number | undefined {
	return typeof v === "number" && isFinite(v) && v > 0 ? v : undefined;
}

/**
 * Merged model-override map: built-in MODEL_OVERRIDES (case 3 defaults that
 * match the gateway's real data, so common offenders work out of the box)
 * merged under the user's omniroute-upstreams.json "overrides" entries, which
 * win on ties. Returns a fresh map each call so it can be parsed once per sync
 * (the config file is re-read live). Fixing a model no longer requires editing
 * + rebuilding the extension.
 */
function loadModelOverrides(): Record<string, { contextWindow?: number; maxTokens?: number }> {
	const merged: Record<string, { contextWindow?: number; maxTokens?: number }> = { ...MODEL_OVERRIDES };
	const userOverrides = loadUpstreamSources().overrides;
	for (const [mid, o] of Object.entries(userOverrides)) {
		const cw = plausibleWindow(o?.contextWindow);
		const mt = plausibleWindow(o?.maxTokens);
		if (cw !== undefined || mt !== undefined) {
			merged[mid] = { ...(MODEL_OVERRIDES[mid] ?? {}), ...(cw !== undefined ? { contextWindow: cw } : {}), ...(mt !== undefined ? { maxTokens: mt } : {}) };
		}
	}
	return merged;
}

/**
 * Returns { contextWindow, maxTokens } for an id from the merged override map,
 * or undefined when the id has no override entry at all.
 */
function resolveModelOverride(
	overrides: Record<string, { contextWindow?: number; maxTokens?: number }>,
	id: string,
): { contextWindow?: number; maxTokens?: number } | undefined {
	return overrides[id];
}

/**
 * Convert OmniRoute `capabilities.effort_tiers` ("none" | "low" | "medium" |
 * "high" | "xhigh") into a pi `thinkingLevelMap`. Listed tiers map 1:1 to
 * their own name ("none" means off is supported, so it keeps pi's default
 * no-reasoning_effort behavior); unlisted pi levels become `null` so they are
 * hidden and never sent. Returns undefined when no tiers are declared, leaving
 * pi's default behavior in place.
 */
function thinkingLevelMapFromTiers(tiers: unknown): Record<string, string | null> | undefined {
	if (!Array.isArray(tiers)) return undefined;
	const tierNames = tiers.filter((t): t is string => typeof t === "string");
	const piLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	if (!tierNames.some((t) => t === "none" || piLevels.includes(t))) return undefined;
	const tiersSet = new Set(tierNames);
	const map: Record<string, string | null> = {};
	for (const level of piLevels) {
		if (level === "off") {
			if (!tiersSet.has("none")) map.off = null;
			continue;
		}
		map[level] = tiersSet.has(level) ? level : null;
	}
	return map;
}

// ---- built-in catalog fallback ---------------------------------------------
// When the gateway publishes no effort_tiers, look the model up in pi's own
// provider catalogs (@earendil-works/pi-ai/dist/providers/data/*.json) and
// inherit its thinkingLevelMap. This reuses the same source pi trusts for its
// own providers (e.g. glm-5.2 => high/max, hy3 => low/high) instead of
// guessing with the default off/low/medium/high list.

let piCatalogDir: string | null | undefined; // undefined = not probed yet
/**
 * One pi-ai catalog model entry we backfill from. pi-ai's own catalogs
 * (@earendil-works/pi-ai/dist/providers/data/*.json) carry the same
 * contextWindow / maxTokens / input / thinkingLevelMap pi trusts for its own
 * providers — we reuse that source so a model with no usable upstream metadata
 * still gets sane values (case 1: upstream provides nothing / invalid data).
 */
interface PiCatalogModel {
	contextWindow?: number;
	maxTokens?: number;
	input?: string[];
	thinkingLevelMap?: Record<string, string | null>;
}

let piCatalogMaps: Record<string, PiCatalogModel> | undefined;

/** Locate pi-ai's provider catalogs by walking up from the `pi` binary. */
function findPiCatalogDir(): string | null {
	if (piCatalogDir !== undefined) return piCatalogDir;
	const fs = require("node:fs");
	const path = require("node:path");
	const cp = require("node:child_process");
	const walkUp = (start: string): string | null => {
		let dir = start;
		for (let i = 0; i < 10 && dir !== "" && dir !== path.dirname(dir); i++) {
			const candidate = path.join(dir, "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data");
			if (fs.existsSync(candidate)) return candidate;
			dir = path.dirname(dir);
		}
		return null;
	};
	try {
		const out = cp.execSync("which pi", { encoding: "utf8", timeout: 5000 }).trim();
		if (out) {
			const found = walkUp(path.dirname(fs.realpathSync(out)));
			if (found) return (piCatalogDir = found);
		}
	} catch {
		/* best-effort: catalog inheritance unavailable */
	}
	// Fallback: walk up from this extension's own file (e.g. a repo checkout).
	piCatalogDir = walkUp(__dirname);
	return piCatalogDir;
}

/**
 * Merge all provider catalogs into root-model-id -> PiCatalogModel. We keep
 * every entry that has at least one usable field (contextWindow / maxTokens /
 * input / thinkingLevelMap) so it can fill gaps the gateway left open. First
 * file wins on ties by field-count, so later catalogs augment rather than
 * clobber a fuller entry for the same id.
 */
function loadPiCatalogMaps(): Record<string, PiCatalogModel> {
	const fs = require("node:fs");
	const path = require("node:path");
	const models: Record<string, PiCatalogModel> = {};
	const dir = findPiCatalogDir();
	if (!dir) return models;
	try {
		for (const file of fs.readdirSync(dir).sort()) {
			if (!file.endsWith(".json")) continue;
			const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
			if (!data) continue;
			for (const section of Object.values(data)) {
				if (!section || typeof section !== "object") continue;
				for (const [mid, m] of Object.entries<any>(section)) {
					if (!m || typeof m !== "object") continue;
					const entry: PiCatalogModel = {};
					const cw = typeof m.contextWindow === "number" && m.contextWindow > 0 ? m.contextWindow : undefined;
					const mt = typeof m.maxTokens === "number" && m.maxTokens > 0 ? m.maxTokens : undefined;
					if (cw) entry.contextWindow = cw;
					if (mt) entry.maxTokens = mt;
					if (Array.isArray(m.input) && m.input.length > 0) entry.input = m.input;
					const tlm: any = m.thinkingLevelMap;
					if (tlm && typeof tlm === "object" && Object.values(tlm).some((v) => typeof v === "string"))
						entry.thinkingLevelMap = tlm;
					// Nothing useful for this id in this catalog — skip so it doesn't
					// clobber a better entry for the same id.
					if (Object.keys(entry).length === 0) continue;
					const existing = models[mid] ?? models[mid.toLowerCase()];
					if (existing && Object.keys(existing).length >= Object.keys(entry).length) continue;
					models[mid] = entry;
					models[mid.toLowerCase()] = entry;
				}
			}
		}
	} catch {
		/* best-effort */
	}
	return models;
}

/**
 * Inherit pi-ai catalog metadata for a gateway model id ("alias/root"). Returns
 * the merged entry (contextWindow / maxTokens / input / thinkingLevelMap) or
 * undefined when nothing matches. The candidate-name logic mirrors the id
 * variants pi's gateway actually uses: full id, alias-stripped root, last
 * segment, and suffix-stripped ("-free" / ":free" / ":free-high") so ids like
 * trk/qwen/qwen3.8-max-free reach the catalog's qwen3.8-max.
 */
function catalogModelMeta(id: string): PiCatalogModel | undefined {
	if (piCatalogMaps === undefined) piCatalogMaps = loadPiCatalogMaps();
	const segs = id.split("/");
	const names = [id, segs.slice(1).join("/"), segs[segs.length - 1]];
	const candidates = new Set<string>();
	for (const name of names) {
		candidates.add(name);
		let cur = name;
		for (let i = 0; i < 3; i++) {
			const next = cur.replace(/(:|-)(free|high|xhigh)$/, "");
			if (next === cur || next.length === 0) break;
			candidates.add(next);
			cur = next;
		}
	}
	for (const candidate of candidates) {
		const entry = piCatalogMaps[candidate] ?? piCatalogMaps[candidate.toLowerCase()];
		if (entry && Object.keys(entry).length > 0) return entry;
	}
	return undefined;
}

/**
 * Inherit a thinkingLevelMap for a gateway model id from pi's catalogs (case
 * 1 backstop for the reasoning-effort selector). The "off" key is always
 * stripped: with the default openai thinkingFormat pi would otherwise send
 * reasoning_effort:"off", which OpenAI-compatible endpoints reject (verified
 * 400 on this gateway).
 */
function catalogThinkingLevelMap(id: string): Record<string, string | null> | undefined {
	const meta = catalogModelMeta(id);
	const map = meta?.thinkingLevelMap;
	if (!map) return undefined;
	const { off: _off, ...rest } = map;
	void _off;
	if (Object.values(rest).some((v) => typeof v === "string")) return rest;
	return undefined;
}

// ---- upstream metadata enrichment
// OmniRoute reports generic/wrong metadata for some providers — e.g. every
// nous/* model gets context_length 128000, no max output tokens, no effort
// tiers, no input modalities — while the provider's own /v1/models endpoint
// has the real values. During sync, rows whose gateway id starts with a known
// provider prefix are patched in place from that upstream endpoint. The ideal
// fix lives in OmniRoute itself; this is a plugin-side workaround.
//
// Pluggable by design: the provider list is configurable at
// ~/.pi/agent/omniroute-upstreams.json (next to models.json; honors PI_HOME),
// merged over built-in defaults. Each entry names a gateway id prefix, the
// provider's /v1/models URL, and a named row extractor. Row shapes differ per
// provider (OpenRouter-style vs plain OpenAI-style), so extraction is named;
// see EXTRACTORS.

/** Normalized authoritative metadata for one gateway model row. */
interface UpstreamMeta {
	contextWindow?: number;
	maxOutputTokens?: number;
	inputModalities?: string[];
	name?: string;
	reasoning?: boolean;
	/** Supported reasoning efforts, e.g. ["none", "low", "high"]. */
	effortTiers?: string[];
	/** false => model rejects tool calls; undefined => unknown, leave as-is. */
	toolsSupported?: boolean;
}

/**
 * Extractor for OpenRouter-shaped rows (top_provider, architecture, reasoning,
 * supported_parameters) — used by nous and any provider that mirrors that
 * schema.
 */
function extractOpenRouter(up: any): UpstreamMeta {
	const meta: UpstreamMeta = {};

	const ctxLen = up.context_length ?? up.top_provider?.context_length;
	if (typeof ctxLen === "number") meta.contextWindow = ctxLen;

	const maxOut = up.top_provider?.max_completion_tokens ?? up.max_output_tokens;
	if (typeof maxOut === "number") meta.maxOutputTokens = maxOut;

	const modalities = up.architecture?.input_modalities;
	if (Array.isArray(modalities) && modalities.length > 0) meta.inputModalities = modalities;

	if (typeof up.name === "string" && up.name) meta.name = up.name;

	if (up.reasoning && typeof up.reasoning === "object") {
		meta.reasoning = true;
		// Reused by thinkingLevelMapFromTiers(): "none" marks off as supported,
		// listed efforts map 1:1 to pi levels ("max"/"xhigh"/"minimal" included).
		if (Array.isArray(up.reasoning.supported_efforts))
			meta.effortTiers = up.reasoning.supported_efforts;
	}

	const params = up.supported_parameters;
	if (Array.isArray(params)) meta.toolsSupported = params.includes("tools");

	return meta;
}

/**
 * Extractor for plain/generic rows: flat fields under common aliases.
 * Forgiving — anything missing simply keeps the gateway's value.
 */
function extractOpenAi(up: any): UpstreamMeta {
	const meta: UpstreamMeta = {};
	const num = (v: unknown) => (typeof v === "number" && v > 0 ? v : undefined);

	meta.contextWindow =
		num(up.context_length) ?? num(up.context_window) ?? num(up.max_input_tokens);
	meta.maxOutputTokens =
		num(up.max_output_tokens) ?? num(up.max_completion_tokens) ?? num(up.max_tokens);

	const modalities = up.input_modalities ?? up.modalities;
	if (Array.isArray(modalities) && modalities.length > 0) meta.inputModalities = modalities;

	if (typeof up.name === "string" && up.name) meta.name = up.name;
	if (up.reasoning === true || up.supports_reasoning_effort === true) meta.reasoning = true;

	return meta;
}

/** Named extractors referenceable from omniroute-upstreams.json. */
const EXTRACTORS: Record<string, (up: any) => UpstreamMeta> = {
	openrouter: extractOpenRouter,
	openai: extractOpenAi,
};

/**
 * One resolved upstream provider: `prefix` matches gateway model ids of the
 * form "<prefix>/<root>"; `extract` normalizes one upstream row; `apiKey`
 * (optional) is sent as a Bearer token for providers that gate /v1/models.
 */
interface UpstreamSource {
	prefix: string;
	url: string;
	extract: (up: any) => UpstreamMeta;
	apiKey?: string;
}

/** JSON config entry in omniroute-upstreams.json (`providers` array). */
interface UpstreamConfigEntry {
	prefix: string;
	url: string;
	/** Extractor name from EXTRACTORS. Defaults to "openrouter". */
	extract?: string;
	/** Bearer token for providers that require auth on /v1/models. */
	apiKey?: string;
	/** true removes this prefix (also disables built-ins). */
	disabled?: boolean;
}

/** Built-in defaults; the JSON config can add, override, or disable entries. */
const BUILTIN_UPSTREAMS: UpstreamConfigEntry[] = [
	{ prefix: "nous", url: "https://inference-api.nousresearch.com/v1/models", extract: "openrouter" },
];

/** Config lives next to models.json, so it follows the same PI_HOME/layout rules. */
function upstreamConfigPath(): string {
	const path = require("node:path");
	return path.join(path.dirname(modelsJsonPath()), "omniroute-upstreams.json");
}

/**
 * Merge built-ins with omniroute-upstreams.json (read fresh each sync, so
 * edits apply on the next /omniroute-sync without a restart). Missing file is
 * the normal zero-config path; a malformed file falls back to built-ins and
 * reports a warning string.
 */
function loadUpstreamSources(): {
	sources: UpstreamSource[];
	overrides: Record<string, { contextWindow?: number; maxTokens?: number }>;
	warning?: string;
} {
	const fs = require("node:fs");
	const configs = new Map<string, UpstreamConfigEntry>();
	for (const entry of BUILTIN_UPSTREAMS) configs.set(entry.prefix, entry);

	const warnings: string[] = [];
	let overrides: Record<string, { contextWindow?: number; maxTokens?: number }> = {};
	try {
		const raw = JSON.parse(fs.readFileSync(upstreamConfigPath(), "utf8"));
		const list = Array.isArray(raw?.providers) ? raw.providers : [];
		for (const e of list) {
			if (!e || typeof e.prefix !== "string" || !e.prefix) continue;
			if (e.disabled === true) {
				configs.delete(e.prefix);
				continue;
			}
			if (typeof e.url !== "string" || !/^https?:\/\//.test(e.url)) continue;
			configs.set(e.prefix, { ...configs.get(e.prefix), ...e });
		}
		// Manual model overrides (case 3): keyed by model id, merged over the
		// built-in MODEL_OVERRIDES at sync time via resolveModelOverride().
		if (raw?.overrides && typeof raw.overrides === "object") {
			for (const [mid, o] of Object.entries<any>(raw.overrides)) {
				if (!mid) continue;
				const cw = typeof o?.contextWindow === "number" ? o.contextWindow : undefined;
				const mt = typeof o?.maxTokens === "number" ? o.maxTokens : undefined;
				if (cw === undefined && mt === undefined) continue;
				overrides[mid] = { ...(cw !== undefined ? { contextWindow: cw } : {}), ...(mt !== undefined ? { maxTokens: mt } : {}) };
			}
		}
	} catch (err: any) {
		if (err?.code !== "ENOENT")
			warnings.push(`omniroute-upstreams.json ignored: ${err?.message ?? err}`);
	}

	const sources: UpstreamSource[] = [];
	for (const cfg of configs.values()) {
		const name = cfg.extract ?? "openrouter";
		const extract = EXTRACTORS[name];
		if (!extract) warnings.push(`unknown extractor "${name}" for "${cfg.prefix}", using openrouter`);
		sources.push({
			prefix: cfg.prefix,
			url: cfg.url,
			extract: extract ?? extractOpenRouter,
			apiKey: typeof cfg.apiKey === "string" && cfg.apiKey ? cfg.apiKey : undefined,
		});
	}
	return { sources, overrides, warning: warnings.length > 0 ? warnings.join("; ") : undefined };
}

/** Fetch an upstream provider's /v1/models and index rows by model id. */
async function fetchUpstreamIndex(url: string, apiKey?: string): Promise<Map<string, any> | undefined> {
	try {
		const res = await fetch(url, {
			headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
			signal: AbortSignal.timeout(10000),
		});
		if (!res.ok) return undefined;
		const json = await res.json();
		const rows = Array.isArray(json?.data) ? json.data : [];
		const index = new Map<string, any>();
		for (const m of rows) if (m?.id) index.set(m.id, m);
		return index;
	} catch {
		return undefined;
	}
}

/** Resolve an upstream row for a root id, trying suffix-stripped variants. */
function lookupUpstream(index: Map<string, any>, root: string): any | undefined {
	let cur = root;
	for (let i = 0; i < 4; i++) {
		const hit = index.get(cur) ?? index.get(cur.toLowerCase());
		if (hit) return hit;
		const next = cur.replace(/(:|-)(free|high|xhigh)$/, "");
		if (next === cur || next.length === 0) break;
		cur = next;
	}
	return undefined;
}

/** Patch one gateway row in place with normalized upstream metadata. */
function applyUpstreamMeta(row: any, meta: UpstreamMeta): void {
	if (typeof meta.contextWindow === "number") row.context_length = meta.contextWindow;
	if (typeof meta.maxOutputTokens === "number") row.max_output_tokens = meta.maxOutputTokens;
	if (Array.isArray(meta.inputModalities) && meta.inputModalities.length > 0)
		row.input_modalities = meta.inputModalities;
	if (typeof meta.name === "string" && meta.name) row.name = meta.name;

	row.capabilities = { ...(row.capabilities ?? {}) };
	if (meta.reasoning) {
		row.capabilities.reasoning = true;
		if (meta.effortTiers) row.capabilities.effort_tiers = meta.effortTiers;
	}
	if (meta.toolsSupported === false) row.capabilities.tool_calling = false;
}

/**
 * Enrich gateway rows from upstream provider catalogs. Best-effort: an
 * unreachable upstream leaves rows untouched. Returns the enriched count and
 * any config warning (malformed omniroute-upstreams.json, unknown extractor).
 */
async function enrichFromUpstream(data: any[]): Promise<{ enriched: number; warning?: string }> {
	const { sources, warning } = loadUpstreamSources();
	const byPrefix = new Map(sources.map((s) => [s.prefix, s]));

	const byProvider = new Map<string, any[]>();
	for (const m of data) {
		const id = typeof m === "string" ? undefined : m?.id;
		if (typeof id !== "string") continue;
		const slash = id.indexOf("/");
		if (slash <= 0) continue;
		const prefix = id.slice(0, slash);
		if (!byPrefix.has(prefix)) continue;
		const list = byProvider.get(prefix) ?? [];
		if (list.length === 0) byProvider.set(prefix, list);
		list.push(m);
	}

	let enriched = 0;
	for (const [prefix, rows] of byProvider) {
		const source = byPrefix.get(prefix);
		if (!source) continue;
		const index = await fetchUpstreamIndex(source.url, source.apiKey);
		if (!index) continue; /* best-effort: keep gateway data */
		for (const row of rows) {
			const root = String(row.id).slice(prefix.length + 1);
			const up = lookupUpstream(index, root);
			if (!up) continue;
			applyUpstreamMeta(row, source.extract(up));
			enriched++;
		}
	}
	return { enriched, warning };
}

/**
 * pi only supports text and image input modalities — no api implementation
 * handles video, so a model advertising it (e.g. OpenRouter catalogs list
 * "video" in architecture.input_modalities for video-capable models, and
 * upstream enrichment copies that verbatim) would claim a modality pi can
 * never actually send. Filter to what pi supports; a model whose declared
 * modalities contain neither text nor image falls back to pi's default
 * ["text"] so the entry stays usable.
 */
const PI_INPUT_MODALITIES = new Set(["text", "image"]);

function sanitizeInputModalities(mods: unknown): string[] | undefined {
	if (!Array.isArray(mods)) return undefined;
	const filtered = mods.filter(
		(m): m is string => typeof m === "string" && PI_INPUT_MODALITIES.has(m),
	);
	return filtered.length > 0 ? filtered : undefined;
}

/** Convert OmniRoute /v1/models rows into pi models.json model entries. */
function toModels(data: any[]): any[] {
	// Parse the override map once for the whole sync (built-ins merged under the
	// user's omniroute-upstreams.json "overrides" entries, which win).
	const out: any[] = [];
	const overrides = loadModelOverrides();
	for (const m of data) {
		const id = typeof m === "string" ? m : m.id;
		if (!id) continue;

		// Seed input modalities; pi only supports text/image. The gateway value is
		// trusted when it yields something usable (sanitizeInputModalities already
		// drops unsupported modalities and falls back to undefined for empty),
		// and the pi-ai catalog backfill below is the gap-filler for case 1.
		const entry: any = {
			id,
			input:
				sanitizeInputModalities(m.input_modalities) ??
				sanitizeInputModalities(m.input) ??
				["text"],
		};

		// Preserve a friendly name when available.
		const name =
			typeof m === "object" ? (m.name ?? m.root ?? m.id) : id;
		if (name && name !== id) entry.name = name;

		// --- contextWindow / maxTokens resolution ---------------------------
		// Precedence (highest first):
		//   3. pi-ai catalog (case 1 backstop — fills missing/invalid data)
		//   2. gateway /v1/models (trusted only when plausible — case 3 guard)
		//   1. pi default (omitted entirely; pi falls back to its own default)
		// A manual override (case 3, lowest effort to set) is applied on top of
		// all of the above at the end of this block via resolveModelOverride().
		const gwCtx = plausibleWindow(m.context_length ?? m.max_input_tokens);
		const gwMax = plausibleWindow(m.max_output_tokens ?? m.max_tokens);

		// Case 1 backstop: inherit from pi-ai's own catalogs (same source pi
		// trusts). Only fills gaps — never overrides a plausible gateway value.
		const catalog = catalogModelMeta(id);
		if (gwCtx === undefined && catalog?.contextWindow !== undefined)
			entry.contextWindow = catalog.contextWindow;
		if (gwMax === undefined && catalog?.maxTokens !== undefined)
			entry.maxTokens = catalog.maxTokens;
		// A plausible gateway value beats an absent catalog value; only when the
		// gateway gave nothing usable does the catalog value (set above) survive.
		if (gwCtx !== undefined) entry.contextWindow = gwCtx;
		if (gwMax !== undefined) entry.maxTokens = gwMax;

		// Input modalities: trust the gateway if it declared anything usable;
		// otherwise backfill from the pi-ai catalog (it lists text/image too).
		if (entry.input.length === 1 && entry.input[0] === "text" && Array.isArray(catalog?.input)) {
			const cmod = sanitizeInputModalities(catalog.input);
			if (cmod) entry.input = cmod;
		}

		// pi's model override path reads model.cost.tiers; a missing cost object
		// throws "Cannot read properties of undefined (reading 'tiers')".
		entry.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

		if (m.capabilities?.tool_calling === false) entry.tool_calling = false;
		const reasoning = !!(m.capabilities?.reasoning || m.capabilities?.thinking);
		if (reasoning) entry.reasoning = true;

		// Reasoning effort: a manual override wins, else derive from the gateway's
		// declared capabilities.effort_tiers so the thinking-level selector only
		// offers levels the model accepts (pi never sends an invalid
		// reasoning_effort, e.g. `high` on qwen3.8-max -> 400).
		// Per the extension's design: gateway effort_tiers first, pi's built-in
		// catalog second, and nothing (pi's default off/low/medium/high) otherwise.
		const thinkingMap = reasoning ? thinkingLevelMapFromTiers(m.capabilities?.effort_tiers) : undefined;
		const inherited = thinkingMap ?? (reasoning ? catalogThinkingLevelMap(id) : undefined);
		if (inherited) entry.thinkingLevelMap = inherited;

		// Case 3: manual overrides (built-in MODEL_OVERRIDES merged over the
		// user's omniroute-upstreams.json "overrides" map). Applied last and
		// unconditionally because the operator explicitly named this id — it wins
		// over both gateway and catalog values. Fixing a model no longer requires
		// editing + rebuilding the extension.
		const override = resolveModelOverride(overrides, id);
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

			const { enriched, warning: upstreamWarning } = await enrichFromUpstream(data);
			if (upstreamWarning) ctx.ui.notify(`⚠️ ${upstreamWarning}`, "warning");
			const models = toModels(data);
			config.providers ??= {};
			config.providers[PROVIDER_ID] = {
				baseUrl,
				api: API,
				apiKey: apiKey || "dummy",
				models,
			};
			writeModelsJson(config);

			// A successful sync proves the gateway is reachable, so repaint the
			// status bar from the known-good state instead of waiting for the next
			// 60s timer tick to clear a stale ✗.
			lastHealthy = true;
			if (ctx.mode === "tui") renderStatus(ctx);

			try {
				ctx.modelRegistry.refresh();
			} catch {
				/* refresh best-effort; reload picks it up */
			}

			ctx.ui.notify(
				`✅ Synced ${models.length} models to Ctrl+P (api: ${API})` +
					(enriched > 0 ? `, ${enriched} enriched from upstream metadata.` : "."),
				"info",
			);
		},
	});
}
