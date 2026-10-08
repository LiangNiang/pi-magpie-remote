import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";

export interface MagpieEntry {
	id: string;
	[key: string]: unknown;
}

type MagpieChatModel = Extract<NonNullable<ProviderConfig["models"]>[number], { type?: "chat" }>;
type CatalogContext = Parameters<NonNullable<ProviderConfig["refreshModels"]>>[0];

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const CLAUDE_FAMILY = /(?:^|[-_.])(?:claude|opus|sonnet|haiku)(?:[-_.]|$)/i;
const CLAUDE_VERSION =
	/(?:^|[^a-z0-9])(?:claude-)?(?:opus|sonnet|haiku)-(\d{1,2})(?:[-.](\d{1,2}))?(?:[^0-9]|$)|claude-(\d+)(?:[-.](\d))-(?:opus|sonnet|haiku)/i;

export function normalizeMagpieUrl(value: string): string {
	let root = value.trim().replace(/\/+$/, "");
	if (!root) throw new Error("Remote magpie address is required");
	if (!root.includes("://")) root = `http://${root}`;
	for (const suffix of ["/v1/messages", "/v1/chat/completions", "/v1/responses", "/v1"]) {
		if (root.endsWith(suffix)) {
			root = root.slice(0, -suffix.length);
			break;
		}
	}
	return root;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function catalogEntries(value: unknown): MagpieEntry[] {
	if (!isRecord(value) || !Array.isArray(value.data)) {
		throw new Error("invalid model catalog returned by remote magpie");
	}
	return value.data.filter(
		(entry): entry is MagpieEntry =>
			isRecord(entry) &&
			typeof entry.id === "string" &&
			entry.id.length > 0 &&
			!(typeof entry.kind === "string" && entry.kind.length > 0),
	);
}

export async function fetchMagpieCatalog(root: string, key: string, signal?: AbortSignal): Promise<MagpieEntry[]> {
	const url = `${root}/v1/models`;
	let response: Response;
	try {
		response = await fetch(url, {
			headers: {
				accept: "application/json",
				...(key ? { Authorization: `Bearer ${key}` } : {}),
			},
			signal,
		});
	} catch (error) {
		if (signal?.aborted) throw error;
		throw new Error(`cannot reach ${root}`, { cause: error });
	}
	if (response.status === 401 || response.status === 403) {
		throw new Error("gateway key rejected (is Share on local network on and the key enabled?)");
	}
	if (!response.ok) throw new Error(`model list request to ${root} failed with HTTP ${response.status}`);
	return catalogEntries(await response.json());
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function positiveNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function lastPathSegment(id: string): string {
	return id.slice(id.lastIndexOf("/") + 1).toLowerCase();
}

function claudeVersionAtLeast46(id: string): boolean {
	const match = CLAUDE_VERSION.exec(lastPathSegment(id));
	if (!match) return false;
	const major = Number(match[1] ?? match[3]);
	const minor = Number(match[2] ?? match[4] ?? 0);
	return major > 4 || (major === 4 && minor >= 6);
}

function thinkingLevelMap(levels: string[], anthropicClaude: boolean): MagpieChatModel["thinkingLevelMap"] {
	if (levels.length === 0) return undefined;
	const map: NonNullable<MagpieChatModel["thinkingLevelMap"]> = {};
	for (const level of THINKING_LEVELS) {
		const effort = level === "off" ? "none" : level;
		map[level] = levels.includes(effort) ? effort : null;
	}
	if (map.off === null && anthropicClaude) delete map.off;
	return map;
}

export function mapMagpieEntry(entry: MagpieEntry, root: string): MagpieChatModel {
	const id = entry.id;
	const nativeEndpoints = stringArray(entry.native_endpoints);
	const api = nativeEndpoints.includes("/v1/responses")
		? "openai-responses"
		: nativeEndpoints.includes("/v1/messages")
			? "anthropic-messages"
			: "openai-completions";
	const finalId = lastPathSegment(id);
	const levels = isRecord(entry) && Array.isArray(entry.supported_reasoning_levels)
		? entry.supported_reasoning_levels.flatMap((level) =>
				isRecord(level) && typeof level.effort === "string" ? [level.effort] : [],
			)
		: [];
	const contextWindow = positiveNumber(entry.context_window, positiveNumber(entry.context_length, 128000));
	const maxTokens = Math.min(positiveNumber(entry.max_output_tokens, 16384), contextWindow);
	const modalities = isRecord(entry.modalities) ? stringArray(entry.modalities.input) : [];
	const model: MagpieChatModel = {
		id,
		name:
			(typeof entry.magpie_label === "string" && entry.magpie_label) ||
			(typeof entry.display_name === "string" && entry.display_name) ||
			id,
		api,
		baseUrl: api === "anthropic-messages" ? root : `${root}/v1`,
		input: modalities.includes("image") ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: entry.reasoning === true || levels.length > 0,
		contextWindow,
		maxTokens,
	};
	const levelMap = thinkingLevelMap(levels, api === "anthropic-messages" && CLAUDE_FAMILY.test(finalId));
	if (levelMap) model.thinkingLevelMap = levelMap;
	if (api === "anthropic-messages" && claudeVersionAtLeast46(id)) {
		model.compat = { forceAdaptiveThinking: true };
	}
	if (api === "anthropic-messages" && finalId.startsWith("claude")) {
		model.promptCache = { short: 300, long: 3600 };
	} else if (api === "openai-responses" && finalId.startsWith("gpt")) {
		model.promptCache = { short: 300 };
	}
	return model;
}

export function mapMagpieCatalog(entries: unknown, root: string): MagpieChatModel[] {
	if (!Array.isArray(entries)) return [];
	return entries.flatMap((entry) => {
		if (
			!isRecord(entry) ||
			typeof entry.id !== "string" ||
			entry.id.length === 0 ||
			(typeof entry.kind === "string" && entry.kind.length > 0)
		) {
			return [];
		}
		return [mapMagpieEntry(entry as MagpieEntry, root)];
	});
}

export async function loginMagpie(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const address = await callbacks.onPrompt({
		message: "Remote magpie address",
		placeholder: "http://192.168.1.20:3425",
	});
	const root = normalizeMagpieUrl(address);
	const key = await callbacks.onPrompt({
		message: "Gateway key (magpie gateway-key add …)",
		allowEmpty: true,
	});
	callbacks.onProgress?.("Fetching model list…");
	const models = await fetchMagpieCatalog(root, key, callbacks.signal);
	return {
		access: key,
		refresh: key,
		expires: Date.now() + 60 * 60 * 1000,
		baseUrl: root,
		models,
	};
}

export async function refreshMagpieToken(
	credentials: OAuthCredentials,
	signal: AbortSignal,
): Promise<OAuthCredentials> {
	try {
		const root = typeof credentials.baseUrl === "string" ? normalizeMagpieUrl(credentials.baseUrl) : "";
		if (!root || typeof credentials.access !== "string") throw new Error("invalid remote magpie credentials");
		const models = await fetchMagpieCatalog(root, credentials.access, signal);
		return { ...credentials, models, expires: Date.now() + 60 * 60 * 1000 };
	} catch {
		return { ...credentials, expires: Date.now() + 10 * 60 * 1000 };
	}
}

export async function refreshMagpieModels(context: CatalogContext): Promise<MagpieChatModel[]> {
	const credential = context.credential?.type === "oauth" ? context.credential : undefined;
	if (!credential || typeof credential.baseUrl !== "string" || !Array.isArray(credential.models)) return [];
	let root: string;
	try {
		root = normalizeMagpieUrl(credential.baseUrl);
	} catch {
		return [];
	}
	if (context.allowNetwork && !context.signal.aborted && typeof credential.access === "string") {
		try {
			const entries = await fetchMagpieCatalog(root, credential.access, context.signal);
			return mapMagpieCatalog(entries, root);
		} catch {}
	}
	return mapMagpieCatalog(credential.models, root);
}

/**
 * pi sends Anthropic-style keys only as x-api-key, which a proxy in front of magpie may not accept,
 * so /v1/messages models also carry the gateway key as a Bearer header. pi ignores headers on
 * refreshed models, hence this runs as the OAuth model projection.
 */
export function withGatewayBearer<T extends { api?: string; headers?: Record<string, string> }>(models: T[], key: string): T[] {
	if (!key) return models;
	return models.map((m) =>
		m.api === "anthropic-messages" ? { ...m, headers: { ...m.headers, Authorization: `Bearer ${key}` } } : m,
	);
}
