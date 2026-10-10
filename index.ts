import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loginMagpie, normalizeMagpieUrl, refreshMagpieModels, refreshMagpieToken } from "./magpie.ts";
import {
	fetchMagpieQuotas,
	formatQuotaReport,
	formatQuotaStatus,
	type MagpieQuota,
	mostUsed,
	quotaProviderOf,
	quotasForModel,
} from "./quota.ts";

const PROVIDER = "magpie-remote";
const STATUS_KEY = "magpie-quota";
const QUOTA_TTL_MS = 60_000;

export default function (pi: ExtensionAPI): void {
	pi.registerProvider(PROVIDER, {
		name: "Magpie (remote)",
		baseUrl: "http://127.0.0.1:3425/v1",
		api: "openai-completions",
		models: [],
		refreshModels: refreshMagpieModels,
		oauth: {
			name: "Magpie (remote)",
			login: loginMagpie,
			refreshToken: refreshMagpieToken,
			getApiKey: (credentials) => credentials.access,
		},
	});

	let cached: { at: number; quotas: MagpieQuota[] } | undefined;
	let pending: Promise<MagpieQuota[]> | undefined;

	async function loadQuotas(ctx: ExtensionContext, force: boolean): Promise<MagpieQuota[]> {
		if (!force && cached && Date.now() - cached.at < QUOTA_TTL_MS) return cached.quotas;
		pending ??= (async () => {
			const model =
				ctx.model?.provider === PROVIDER ? ctx.model : ctx.modelRegistry.getAll().find((m) => m.provider === PROVIDER);
			if (!model) throw new Error("not logged in to Magpie (remote) — run /login first");
			const key = (await ctx.modelRegistry.getApiKeyForProvider(PROVIDER)) ?? "";
			const quotas = await fetchMagpieQuotas(normalizeMagpieUrl(model.baseUrl), key, AbortSignal.timeout(20_000));
			cached = { at: Date.now(), quotas };
			return quotas;
		})()
			.catch((error: unknown) => {
				cached = undefined;
				throw error;
			})
			.finally(() => {
				pending = undefined;
			});
		return pending;
	}

	async function updateStatus(ctx: ExtensionContext, force = false): Promise<void> {
		if (!ctx.hasUI) return;
		const model = ctx.model;
		if (model?.provider !== PROVIDER) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		let quotas: MagpieQuota[];
		try {
			quotas = quotasForModel(await loadQuotas(ctx, force), model.id);
		} catch {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		if (ctx.model?.provider !== PROVIDER || ctx.model.id !== model.id) return;
		const [first] = quotas;
		if (!first) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const used = mostUsed(first) ?? 0;
		const color = first.error ? "muted" : used >= 90 ? "error" : used >= 75 ? "warning" : "dim";
		const more = quotas.length > 1 ? ` +${quotas.length - 1}` : "";
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, formatQuotaStatus(first) + more));
	}

	pi.on("session_start", (_event, ctx) => {
		// Match what opening /model does in the TUI: pick up a gateway change without leaving the session.
		// refreshMagpieModels keeps its own five minute window, so this stays off the hot path.
		void ctx.modelRegistry.refresh({ providers: [PROVIDER] }).catch(() => {});
		void updateStatus(ctx);
	});
	pi.on("model_select", (_event, ctx) => void updateStatus(ctx));
	pi.on("agent_end", (_event, ctx) => void updateStatus(ctx));

	pi.registerCommand("magpie-quota", {
		description: "Show the remote Magpie's subscription, plan and key quotas",
		handler: async (args, ctx) => {
			let quotas: MagpieQuota[];
			try {
				quotas = await loadQuotas(ctx, true);
			} catch (error) {
				if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.notify(`Magpie quota: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			const only = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			const shown = only.length
				? quotas.filter((q) => only.some((o) => quotaProviderOf(q.provider) === o || q.name.toLowerCase() === o || q.kind === o))
				: quotas;
			ctx.ui.notify(formatQuotaReport(shown), "info");
			void updateStatus(ctx);
		},
	});
}
