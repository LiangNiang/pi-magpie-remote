import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import test from "node:test";
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import {
	CATALOG_TTL_MS,
	fetchMagpieCatalog,
	loginMagpie,
	mapMagpieCatalog,
	normalizeMagpieUrl,
	refreshMagpieModels,
	refreshMagpieToken,
} from "../magpie.ts";

async function startCatalogServer(
	handle: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ root: string; server: Server }> {
	const server = createServer(handle);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("catalog server did not bind a TCP port");
	return { root: `http://127.0.0.1:${address.port}`, server };
}

async function closeServer(server: Server): Promise<void> {
	server.close();
	await once(server, "close");
}

test("normalizes remote magpie URL suffixes", () => {
	assert.equal(normalizeMagpieUrl(" 192.168.1.20:3425 "), "http://192.168.1.20:3425");
	assert.equal(normalizeMagpieUrl("http://h:3425/v1/"), "http://h:3425");
	assert.equal(normalizeMagpieUrl("https://m.example.com/v1/messages"), "https://m.example.com");
	assert.equal(normalizeMagpieUrl("http://h:3425/v1/chat/completions"), "http://h:3425");
	assert.equal(normalizeMagpieUrl("https://h:3425/v1/responses"), "https://h:3425");
});

test("maps endpoint-specific API metadata, names, modalities and token limits", () => {
	const models = mapMagpieCatalog(
		[
			{
				id: "openai/gpt-5.5",
				display_name: "GPT 5.5",
				magpie_label: "Fast · Remote",
				native_endpoints: ["/v1/responses"],
				context_window: 90000,
				max_output_tokens: 100000,
				modalities: { input: ["text", "image"] },
			},
			{
				id: "anthropic/claude-opus-4-7",
				native_endpoints: ["/v1/messages"],
				supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "max" }],
				context_length: 200000,
				max_output_tokens: 64000,
			},
			{ id: "chat-only", reasoning: true },
			{ id: "group/daily", display_name: "Daily" },
			{ id: "image-input", modalities: { input: ["text", "image"] } },
			{ id: "drawer", kind: "image" },
			{ display_name: "missing id" },
		],
		"http://magpie.test",
	);

	assert.equal(models.length, 5);
	assert.deepEqual(
		models.map(({ id, api }) => [id, api]),
		[
			["openai/gpt-5.5", "openai-responses"],
			["anthropic/claude-opus-4-7", "anthropic-messages"],
			["chat-only", "openai-completions"],
			["group/daily", "openai-completions"],
			["image-input", "openai-completions"],
		],
	);
	assert.equal(models[0]?.name, "Fast · Remote");
	assert.equal(models[0]?.baseUrl, "http://magpie.test/v1");
	assert.equal(models[0]?.maxTokens, 90000);
	assert.deepEqual(models[0]?.promptCache, { short: 300 });
	assert.equal(models[1]?.baseUrl, "http://magpie.test");
	assert.equal(models[1]?.reasoning, true);
	assert.deepEqual(models[1]?.compat, { forceAdaptiveThinking: true });
	assert.deepEqual(models[1]?.promptCache, { short: 300, long: 3600 });
	assert.deepEqual(models[3]?.input, ["text"]);
	assert.deepEqual(models[4]?.input, ["text", "image"]);
	assert.deepEqual(models[2]?.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("maps reasoning efforts and omits unsupported off for Anthropic Claude", () => {
	const [claude, openai] = mapMagpieCatalog(
		[
			{
				id: "claude-opus-4-7",
				native_endpoints: ["/v1/messages"],
				supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }],
			},
			{
				id: "gpt-reasoner",
				native_endpoints: ["/v1/responses"],
				supported_reasoning_levels: [{ effort: "none" }, { effort: "high" }],
			},
		],
		"http://magpie.test",
	);
	assert.equal(Object.hasOwn(claude?.thinkingLevelMap ?? {}, "off"), false);
	assert.deepEqual(claude?.thinkingLevelMap, {
		minimal: null,
		low: "low",
		medium: null,
		high: null,
		xhigh: null,
		max: "max",
	});
	assert.deepEqual(openai?.thinkingLevelMap, {
		off: "none",
		minimal: null,
		low: null,
		medium: null,
		high: "high",
		xhigh: null,
		max: null,
	});
});

test("fetches a catalog and stores login credentials", async () => {
	const seen: string[] = [];
	const { root, server } = await startCatalogServer((request, response) => {
		seen.push(request.headers.authorization ?? "");
		assert.equal(request.url, "/v1/models");
		assert.equal(request.headers.accept, "application/json");
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ data: [{ id: "fake-model" }] }));
	});
	try {
		const prompts: string[] = [];
		const progress: string[] = [];
		const callbacks: OAuthLoginCallbacks = {
			onAuth() {},
			onDeviceCode() {},
			onPrompt: async (prompt) => {
				prompts.push(prompt.message);
				return prompts.length === 1 ? `${root}/v1/` : "gateway-secret";
			},
			onProgress: (message) => progress.push(message),
			onSelect: async () => undefined,
		};
		const credentials = await loginMagpie(callbacks);
		assert.deepEqual(prompts, ["Remote magpie address", "Gateway key (magpie gateway-key add …)"]);
		assert.deepEqual(progress, ["Fetching model list…"]);
		assert.deepEqual(seen, ["Bearer gateway-secret"]);
		assert.equal(credentials.access, "gateway-secret");
		assert.equal(credentials.refresh, "gateway-secret");
		assert.equal(credentials.baseUrl, root);
		assert.deepEqual(credentials.models, [{ id: "fake-model" }]);
		assert.ok(credentials.expires > Date.now());
	} finally {
		await closeServer(server);
	}
});

test("login reports rejected gateway keys and accepts an empty catalog", async () => {
	const unauthorized = await startCatalogServer((_request, response) => {
		response.writeHead(401);
		response.end();
	});
	try {
		await assert.rejects(fetchMagpieCatalog(unauthorized.root, "wrong"), {
			message: "gateway key rejected (is Share on local network on and the key enabled?)",
		});
	} finally {
		await closeServer(unauthorized.server);
	}

	const empty = await startCatalogServer((_request, response) => {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ data: [] }));
	});
	try {
		const callbacks: OAuthLoginCallbacks = {
			onAuth() {},
			onDeviceCode() {},
			onPrompt: async ({ message }) => (message === "Remote magpie address" ? empty.root : ""),
			onSelect: async () => undefined,
		};
		const credentials = await loginMagpie(callbacks);
		assert.deepEqual(credentials.models, []);
	} finally {
		await closeServer(empty.server);
	}
});

test("refresh token keeps the credential usable when the remote is unavailable", async () => {
	const { root, server } = await startCatalogServer((_request, response) => {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ data: [{ id: "fresh-model" }] }));
	});
	const existing = {
		access: "gateway-secret",
		refresh: "gateway-secret",
		expires: 0,
		baseUrl: root,
		models: [{ id: "old-model" }],
	};
	try {
		const refreshed = await refreshMagpieToken(existing, new AbortController().signal);
		assert.deepEqual(refreshed.models, [{ id: "fresh-model" }]);
		assert.ok(refreshed.expires > Date.now());
	} finally {
		await closeServer(server);
	}

	const expiresBefore = Date.now();
	const offline = await refreshMagpieToken(existing, new AbortController().signal);
	assert.deepEqual(offline.models, existing.models);
	assert.ok(offline.expires >= expiresBefore + 9 * 60 * 1000);
	assert.ok(offline.expires <= Date.now() + 10 * 60 * 1000);
});

test("model refresh uses the snapshot offline and after a network failure", async () => {
	let requests = 0;
	const { root, server } = await startCatalogServer((_request, response) => {
		requests++;
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ data: [{ id: "live-model" }] }));
	});
	const context = {
		credential: {
			type: "oauth" as const,
			access: "gateway-secret",
			refresh: "gateway-secret",
			expires: Date.now() + 60 * 60 * 1000,
			baseUrl: root,
			models: [{ id: "cached-model" }],
		},
		publish: async () => true,
		allowNetwork: false,
		signal: new AbortController().signal,
	};
	try {
		const offline = await refreshMagpieModels(context);
		assert.deepEqual(offline.map(({ id }) => id), ["cached-model"]);
		assert.equal(requests, 0);
	} finally {
		await closeServer(server);
	}

	const unavailable = await refreshMagpieModels({ ...context, allowNetwork: true });
	assert.deepEqual(unavailable.map(({ id }) => id), ["cached-model"]);
});

type ModelRefreshContext = Parameters<typeof refreshMagpieModels>[0];

function refreshContext(overrides: Record<string, unknown>): ModelRefreshContext {
	return {
		publish: async () => true,
		allowNetwork: false,
		signal: new AbortController().signal,
		...overrides,
	} as unknown as ModelRefreshContext;
}

function credentialFor(root: string, models: { id: string }[]) {
	return {
		type: "oauth",
		access: "gateway-secret",
		refresh: "gateway-secret",
		expires: Date.now() + 60 * 60 * 1000,
		baseUrl: root,
		models,
	};
}

function persistedModel(id: string, root: string) {
	return { id, name: id, api: "openai-completions", baseUrl: `${root}/v1` };
}

test("model refresh prefers the persisted catalog over the credential snapshot", async () => {
	const root = "http://127.0.0.1:3425";
	const models = await refreshMagpieModels(
		refreshContext({
			credential: credentialFor(root, [{ id: "stale-model" }]),
			stored: { models: [persistedModel("persisted-model", root)], checkedAt: Date.now() },
		}),
	);
	assert.deepEqual(models.map(({ id }) => id), ["persisted-model"]);
});

test("model refresh ignores a catalog persisted for another gateway", async () => {
	const models = await refreshMagpieModels(
		refreshContext({
			credential: credentialFor("http://new-host:3425", [{ id: "credential-model" }]),
			stored: { models: [persistedModel("other-gateway", "http://old-host:3425")], checkedAt: Date.now() },
		}),
	);
	assert.deepEqual(models.map(({ id }) => id), ["credential-model"]);
});

test("model refresh persists a freshly fetched catalog", async () => {
	let requests = 0;
	const { root, server } = await startCatalogServer((_request, response) => {
		requests++;
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ data: [{ id: "live-model" }] }));
	});
	const publications: { persist?: { models: { id: string }[]; checkedAt?: number } }[] = [];
	try {
		const models = await refreshMagpieModels(
			refreshContext({
				credential: credentialFor(root, [{ id: "cached-model" }]),
				allowNetwork: true,
				publish: async (publication: (typeof publications)[number]) => {
					publications.push(publication);
					return true;
				},
			}),
		);
		assert.deepEqual(models.map(({ id }) => id), ["live-model"]);
		assert.equal(requests, 1);
		const [publication] = publications;
		assert.deepEqual(publication?.persist?.models.map(({ id }) => id), ["live-model"]);
		assert.equal(typeof publication?.persist?.checkedAt, "number");
	} finally {
		await closeServer(server);
	}
});

test("model refresh reuses a fresh persisted catalog until it ages out or force is set", async () => {
	let requests = 0;
	const { root, server } = await startCatalogServer((_request, response) => {
		requests++;
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ data: [{ id: "live-model" }] }));
	});
	const base = {
		credential: credentialFor(root, [{ id: "cached-model" }]),
		allowNetwork: true,
	};
	try {
		const fresh = await refreshMagpieModels(
			refreshContext({ ...base, stored: { models: [persistedModel("persisted-model", root)], checkedAt: Date.now() } }),
		);
		assert.deepEqual(fresh.map(({ id }) => id), ["persisted-model"]);
		assert.equal(requests, 0);

		const stale = await refreshMagpieModels(
			refreshContext({
				...base,
				stored: { models: [persistedModel("persisted-model", root)], checkedAt: Date.now() - CATALOG_TTL_MS - 1000 },
			}),
		);
		assert.deepEqual(stale.map(({ id }) => id), ["live-model"]);
		assert.equal(requests, 1);

		const forced = await refreshMagpieModels(
			refreshContext({ ...base, force: true, stored: { models: [persistedModel("persisted-model", root)], checkedAt: Date.now() } }),
		);
		assert.deepEqual(forced.map(({ id }) => id), ["live-model"]);
		assert.equal(requests, 2);
	} finally {
		await closeServer(server);
	}
});
