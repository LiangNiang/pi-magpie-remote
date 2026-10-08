export interface MagpieQuotaWindow {
	name: string;
	used: number;
	unlimited?: boolean;
	resetsAt?: string;
	display?: string;
}

export interface MagpieQuota {
	provider: string;
	name: string;
	kind: string;
	plan?: string;
	user?: string;
	windows: MagpieQuotaWindow[];
	balance?: string;
	error?: string;
	resets?: { count?: number; until?: string };
	last?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseWindow(value: unknown): MagpieQuotaWindow[] {
	if (!isRecord(value) || typeof value.name !== "string") return [];
	return [
		{
			name: value.name,
			used: typeof value.used === "number" && Number.isFinite(value.used) ? value.used : 0,
			unlimited: value.unlimited === true || undefined,
			resetsAt: optionalString(value.resetsAt),
			display: optionalString(value.display),
		},
	];
}

export function parseMagpieQuotas(value: unknown): MagpieQuota[] {
	if (!isRecord(value) || !Array.isArray(value.data)) throw new Error("invalid quota list returned by remote magpie");
	return value.data.flatMap((entry): MagpieQuota[] => {
		if (!isRecord(entry) || typeof entry.provider !== "string" || entry.provider.length === 0) return [];
		const resets = isRecord(entry.resets)
			? {
					count: typeof entry.resets.count === "number" ? entry.resets.count : undefined,
					until: optionalString(entry.resets.until),
				}
			: undefined;
		return [
			{
				provider: entry.provider,
				name: optionalString(entry.name) ?? entry.provider,
				kind: optionalString(entry.kind) ?? "subscription",
				plan: optionalString(entry.plan),
				user: optionalString(entry.user),
				windows: Array.isArray(entry.windows) ? entry.windows.flatMap(parseWindow) : [],
				balance: optionalString(entry.balance),
				error: optionalString(entry.error),
				resets,
				last: entry.last === true || undefined,
			},
		];
	});
}

export async function fetchMagpieQuotas(root: string, key: string, signal?: AbortSignal): Promise<MagpieQuota[]> {
	let response: Response;
	try {
		response = await fetch(`${root}/v1/magpie/quotas`, {
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
	if (!response.ok) throw new Error(`quota request to ${root} failed with HTTP ${response.status}`);
	return parseMagpieQuotas(await response.json());
}

/** The magpie provider a model id such as `codex/gpt-5.5` is served by. */
export function quotaProviderOf(modelId: string): string {
	const slash = modelId.indexOf("/");
	return (slash > 0 ? modelId.slice(0, slash) : modelId).toLowerCase();
}

/** The quotas of the provider serving modelId, the account that served last first. */
export function quotasForModel(quotas: readonly MagpieQuota[], modelId: string): MagpieQuota[] {
	const provider = quotaProviderOf(modelId);
	return quotas
		.filter((q) => q.provider.toLowerCase() === provider)
		.sort((a, b) => Number(b.last === true) - Number(a.last === true));
}

export function shortWindowName(name: string): string {
	const match = /^(\d+)\s*(hour|day|week|month|minute)s?$/i.exec(name.trim());
	if (!match) return name;
	const unit = match[2]!.toLowerCase();
	return `${match[1]}${unit === "minute" ? "m" : unit === "month" ? "mo" : unit[0]}`;
}

function percent(used: number): string {
	return `${Math.round(used)}%`;
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

/** When a window starts again, as magpie words it: "14:30", "tomorrow 09:00", "Wed 14:30", "Oct 3 14:30". */
export function resetClock(at: Date, now: Date): string {
	const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
	const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	const days = Math.round((day(at) - day(now)) / 86_400_000);
	if (days <= 0) return clock;
	if (days === 1) return `tomorrow ${clock}`;
	if (days < 7) return `${at.toLocaleDateString("en-US", { weekday: "short" })} ${clock}`;
	return `${at.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${clock}`;
}

/** The most used of a quota's limited windows, in percent; undefined when none is limited. */
export function mostUsed(quota: MagpieQuota): number | undefined {
	const used = quota.windows.filter((w) => !w.unlimited).map((w) => w.used);
	return used.length > 0 ? Math.max(...used) : undefined;
}

/** One quota in a few words for the footer: "codex 5h 32% · 7d 71%", "deepseek ¥12.30". */
export function formatQuotaStatus(quota: MagpieQuota): string {
	const parts = quota.windows
		.filter((w) => !w.unlimited)
		.map((w) => `${shortWindowName(w.name)} ${percent(w.used)}`);
	if (quota.balance) parts.push(quota.balance);
	if (parts.length === 0) parts.push(quota.error ? "unavailable" : quota.windows.length > 0 ? "unlimited" : "—");
	return `${quota.provider} ${parts.join(" · ")}`;
}

function quotaTitle(quota: MagpieQuota): string {
	return [quota.provider, quota.plan, quota.user].filter(Boolean).join(" · ");
}

function windowCell(window: MagpieQuotaWindow, now: Date): string {
	if (window.unlimited) return `${window.name} unlimited`;
	let cell = `${window.name} ${percent(window.used)}`;
	if (window.display) cell += ` (${window.display})`;
	const at = window.resetsAt ? new Date(window.resetsAt) : undefined;
	if (at && !Number.isNaN(at.getTime())) cell += ` ↻ ${resetClock(at, now)}`;
	return cell;
}

/** Every quota, one line each, as magpie quota prints them. */
export function formatQuotaReport(quotas: readonly MagpieQuota[], now = new Date()): string {
	if (quotas.length === 0) return "Remote magpie has no subscription, plan or key balance to report.";
	const width = Math.max(...quotas.map((q) => quotaTitle(q).length));
	const lines = quotas.map((q) => {
		const cells = q.windows.map((w) => windowCell(w, now));
		if (q.balance) cells.push(`${q.balance} left`);
		if (q.resets?.count) cells.push(`↺ ${q.resets.count} reset${q.resets.count === 1 ? "" : "s"}`);
		if (q.error) cells.push(q.error);
		return [quotaTitle(q).padEnd(width), q.kind.padEnd(12), ...cells].join("  ").trimEnd();
	});
	return [...lines, "% is how much of a window is used · ↻ when it starts again"].join("\n");
}
