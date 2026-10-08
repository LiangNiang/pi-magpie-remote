import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import test from "node:test";
import {
	fetchMagpieQuotas,
	formatQuotaReport,
	formatQuotaStatus,
	mostUsed,
	parseMagpieQuotas,
	quotasForModel,
	resetClock,
	shortWindowName,
} from "../quota.ts";

const sample = {
	object: "list",
	data: [
		{
			provider: "codex",
			name: "Codex",
			kind: "subscription",
			plan: "Plus",
			user: "a@example.com",
			windows: [
				{ name: "5 hours", used: 32.4, remaining: 67.6, resetsAt: "2026-10-08T14:30:00+08:00" },
				{ name: "7 days", used: 71, remaining: 29 },
			],
			resets: { count: 2 },
		},
		{
			provider: "codex",
			name: "Codex",
			kind: "subscription",
			user: "b@example.com",
			windows: [{ name: "5 hours", used: 5, remaining: 95 }],
			last: true,
		},
		{ provider: "deepseek", name: "DeepSeek", kind: "balance", windows: [], balance: "¥12.50" },
		{ provider: "kimi", name: "Kimi", kind: "balance", windows: [], error: "HTTP 401" },
		{ name: "no provider" },
	],
};

async function startServer(status: number, body: unknown): Promise<{ root: string; server: Server; seen: string[] }> {
	const seen: string[] = [];
	const server = createServer((request, response) => {
		seen.push(`${request.url} ${request.headers.authorization ?? ""}`);
		response.writeHead(status, { "content-type": "application/json" });
		response.end(JSON.stringify(body));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	return { root: `http://127.0.0.1:${address.port}`, server, seen };
}

test("parses magpie's quota report and drops entries without a provider", () => {
	const quotas = parseMagpieQuotas(sample);
	assert.equal(quotas.length, 4);
	assert.equal(quotas[0]!.windows[0]!.used, 32.4);
	assert.equal(quotas[0]!.resets?.count, 2);
	assert.equal(quotas[2]!.balance, "¥12.50");
	assert.throws(() => parseMagpieQuotas({ data: null }), /invalid quota list/);
});

test("fetches /v1/magpie/quotas with the gateway key", async () => {
	const { root, server, seen } = await startServer(200, sample);
	try {
		const quotas = await fetchMagpieQuotas(root, "gk-1");
		assert.equal(quotas.length, 4);
		assert.deepEqual(seen, ["/v1/magpie/quotas Bearer gk-1"]);
	} finally {
		server.close();
	}
});

test("explains a rejected gateway key", async () => {
	const { root, server } = await startServer(403, { error: { message: "no" } });
	try {
		await assert.rejects(fetchMagpieQuotas(root, "bad"), /gateway key rejected/);
	} finally {
		server.close();
	}
});

test("picks the model's provider, the account that served last first", () => {
	const quotas = parseMagpieQuotas(sample);
	const codex = quotasForModel(quotas, "codex/gpt-5.5");
	assert.deepEqual(
		codex.map((q) => q.user),
		["b@example.com", "a@example.com"],
	);
	assert.equal(quotasForModel(quotas, "DeepSeek/deepseek-chat")[0]!.balance, "¥12.50");
	assert.deepEqual(quotasForModel(quotas, "my-group"), []);
});

test("formats footer status", () => {
	const [codex, , deepseek, kimi] = parseMagpieQuotas(sample);
	assert.equal(formatQuotaStatus(codex!), "codex 5h 32% · 7d 71%");
	assert.equal(formatQuotaStatus(deepseek!), "deepseek ¥12.50");
	assert.equal(formatQuotaStatus(kimi!), "kimi unavailable");
	assert.equal(mostUsed(codex!), 71);
	assert.equal(mostUsed(deepseek!), undefined);
	assert.equal(shortWindowName("Monthly"), "1mo");
	assert.equal(shortWindowName("Weekly"), "1w");
	assert.equal(shortWindowName("GLM-5.3-Trial"), "GLM-5.3-Trial");
	assert.equal(shortWindowName("1 week"), "1w");
});

test("keeps the footer to two windows, including the most used, and falls back to the plan", () => {
	const window = (name: string, used: number) => ({ name, used });
	const base = { provider: "zcode", name: "Z", kind: "subscription" };
	assert.equal(
		formatQuotaStatus({ ...base, windows: [window("5 hours", 28), window("Weekly", 38), window("GLM-Trial", 0)] }),
		"zcode 5h 28% · 1w 38%",
	);
	assert.equal(
		formatQuotaStatus({ ...base, windows: [window("5 hours", 10), window("Weekly", 20), window("GLM-Trial", 95)] }),
		"zcode 5h 10% · GLM-Trial 95%",
	);
	assert.equal(formatQuotaStatus({ ...base, plan: "Free", windows: [] }), "zcode Free");
	assert.equal(formatQuotaStatus({ ...base, windows: [] }), "zcode —");
});

test("formats reset times like magpie", () => {
	const now = new Date(2026, 9, 8, 10, 0);
	assert.equal(resetClock(new Date(2026, 9, 8, 14, 30), now), "14:30");
	assert.equal(resetClock(new Date(2026, 9, 9, 9, 5), now), "tomorrow 09:05");
	assert.equal(resetClock(new Date(2026, 9, 10, 9, 5), now), "Sat 09:05");
	assert.equal(resetClock(new Date(2026, 10, 3, 9, 5), now), "Nov 3 09:05");
});

test("formats the full report", () => {
	const report = formatQuotaReport(parseMagpieQuotas(sample), new Date(2026, 9, 8, 10, 0));
	const lines = report.split("\n");
	assert.equal(lines.length, 5);
	assert.match(lines[0]!, /^codex · Plus · a@example\.com {2}subscription {2}5 hours 32% ↻ \S+ {2}7 days 71% {2}↺ 2 resets$/);
	assert.match(lines[2]!, /^deepseek\s+balance\s+¥12\.50 left$/);
	assert.match(lines[3]!, /HTTP 401$/);
	assert.match(formatQuotaReport([]), /no subscription/);
});
