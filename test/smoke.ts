// Read-only smoke test against a real Magpie gateway: `MAGPIE_URL=… MAGPIE_GATEWAY_KEY=… npm run smoke`.
import assert from "node:assert/strict";
import test from "node:test";
import { fetchMagpieCatalog, mapMagpieCatalog, normalizeMagpieUrl } from "../magpie.ts";
import { fetchMagpieQuotas, formatQuotaReport, formatQuotaStatus, quotaProviderOf, quotasForModel } from "../quota.ts";

const url = process.env.MAGPIE_URL;
const key = process.env.MAGPIE_GATEWAY_KEY ?? "";
const skip = url ? false : "set MAGPIE_URL and MAGPIE_GATEWAY_KEY to run against a real magpie";

test("remote magpie lists chat models", { skip }, async () => {
	const root = normalizeMagpieUrl(url!);
	const entries = await fetchMagpieCatalog(root, key, AbortSignal.timeout(20_000));
	const models = mapMagpieCatalog(entries, root);
	assert.ok(models.length > 0, "no chat models");
	console.log(`${models.length} chat models from ${new Set(models.map((m) => quotaProviderOf(m.id))).size} providers`);
});

test("remote magpie accepts pi's auth on every chat API, without spending tokens", { skip }, async () => {
	const root = normalizeMagpieUrl(url!);
	const models = mapMagpieCatalog(await fetchMagpieCatalog(root, key, AbortSignal.timeout(20_000)), root, key);
	for (const api of new Set(models.map((m) => m.api))) {
		const model = models.find((m) => m.api === api)!;
		const path = api === "anthropic-messages" ? "/v1/messages" : api === "openai-responses" ? "/responses" : "/chat/completions";
		const auth = api === "anthropic-messages" ? { "x-api-key": key } : { Authorization: `Bearer ${key}` };
		// An empty body is rejected by magpie as a bad request; a 401/403 means the auth never got through.
		const response = await fetch(`${model.baseUrl}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...auth, ...model.headers },
			body: "{}",
			signal: AbortSignal.timeout(20_000),
		});
		await response.body?.cancel();
		console.log(`${api} (${model.id}): HTTP ${response.status}`);
		assert.ok(response.status !== 401 && response.status !== 403, `${api} auth rejected with HTTP ${response.status}`);
	}
});

test("remote magpie reports quotas the footer and /magpie-quota can show", { skip }, async () => {
	const root = normalizeMagpieUrl(url!);
	const quotas = await fetchMagpieQuotas(root, key, AbortSignal.timeout(20_000));
	const models = mapMagpieCatalog(await fetchMagpieCatalog(root, key, AbortSignal.timeout(20_000)), root);
	for (const q of quotas) {
		assert.ok(q.provider && q.kind, `incomplete quota ${JSON.stringify(q.provider)}`);
		for (const w of q.windows) assert.ok(Number.isFinite(w.used) && w.used >= 0, `${q.provider} ${w.name} used=${w.used}`);
		console.log(`footer: ${formatQuotaStatus(q)}`);
	}
	const covered = new Set(models.map((m) => quotaProviderOf(m.id)).filter((p) => quotasForModel(quotas, `${p}/x`).length > 0));
	console.log(`providers with quota: ${[...covered].join(", ") || "none"}`);
	assert.ok(formatQuotaReport(quotas).length > 0);
});
