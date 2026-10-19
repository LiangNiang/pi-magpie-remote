import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

/** Default folders (relative to cwd) when no path is given. */
export const IMAGE_FOLDER = "generated-images";
export const VIDEO_FOLDER = "generated-videos";
/** How long one image request may take: the gateway draws for up to 5 minutes, then may download for 5 more. */
export const IMAGE_TIMEOUT_MS = 10 * 60_000;
/** How long a video is waited for, and how often it is asked after. */
export const VIDEO_TIMEOUT_MS = 10 * 60_000;
export const VIDEO_POLL_MS = 3_000;
/**
 * The User-Agent of the gateway's own image tool, put after the client's name: Magpie counts the call
 * under the client, and treats it as a drawing it makes for that client.
 */
export const USER_AGENT = "pi magpie-image/1";

const MIME_EXT: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/webp": ".webp",
	"image/gif": ".gif",
	"video/mp4": ".mp4",
	"video/webm": ".webm",
};
const EXT_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
};
const VIDEO_EXTS = new Set([".mp4", ".mov", ".webm", ".m4v"]);

export interface ImageParams {
	prompt: string;
	path?: string;
	size?: string;
	n?: number;
	quality?: string;
	background?: string;
	model?: string;
	reference_images?: string[];
}

export interface VideoParams {
	prompt: string;
	path?: string;
	seconds?: number;
	size?: string;
	model?: string;
	image?: string;
	reference_images?: string[];
}

export interface ImageResponse {
	model?: string;
	text?: string;
	data?: { b64_json?: string; url?: string; mime_type?: string; revised_prompt?: string }[];
	error?: { message?: string };
}

export interface VideoJob {
	id?: string;
	status?: string;
	model?: string;
	seconds?: string;
	progress?: number;
	error?: { message?: string };
}

export interface Saved {
	files: string[];
	notes: string[];
}

/** A reference image as the gateway takes it: URLs as they are, local files as data URLs. */
export async function toImageUrl(ref: string, cwd: string): Promise<string> {
	if (/^(https?:|data:)/i.test(ref)) return ref;
	const path = resolve(cwd, ref.replace(/^file:\/\//, ""));
	const buf = await readFile(path);
	const mime = EXT_MIME[extname(path).toLowerCase()] ?? sniffMime(buf, "");
	if (!mime.startsWith("image/")) throw new Error(`reference image ${ref} is not png/jpeg/webp/gif`);
	return `data:${mime};base64,${buf.toString("base64")}`;
}

/** The OpenAI-style images request: generations, or edits when reference images are given. */
export async function buildImageRequest(
	params: ImageParams,
	cwd: string,
	defaultModel?: string,
): Promise<{ endpoint: string; body: Record<string, unknown> }> {
	if (!params.prompt?.trim()) throw new Error("prompt is required");
	const body: Record<string, unknown> = {
		prompt: params.prompt,
		n: Math.max(1, Math.min(params.n ?? 1, 4)),
		response_format: "b64_json",
	};
	const model = params.model || defaultModel;
	if (model) body.model = model;
	for (const key of ["size", "quality", "background"] as const) {
		if (params[key]) body[key] = params[key];
	}
	if (!params.reference_images?.length) return { endpoint: "/v1/images/generations", body };
	body.images = await Promise.all(
		params.reference_images.map(async (ref) => ({ image_url: await toImageUrl(ref, cwd) })),
	);
	return { endpoint: "/v1/images/edits", body };
}

/** The OpenAI-style videos request; `image` is the first frame to animate. */
export async function buildVideoRequest(
	params: VideoParams,
	cwd: string,
	defaultModel?: string,
): Promise<Record<string, unknown>> {
	if (!params.prompt?.trim()) throw new Error("prompt is required");
	const body: Record<string, unknown> = { prompt: params.prompt };
	const model = params.model || defaultModel;
	if (model) body.model = model;
	if (params.seconds !== undefined) {
		if (!Number.isInteger(params.seconds) || params.seconds < 1) {
			throw new Error(`seconds is a whole number from 1 to 15, not ${params.seconds}`);
		}
		body.seconds = String(params.seconds);
	}
	if (params.size) body.size = params.size;
	if (params.image) body.input_reference = { image_url: await toImageUrl(params.image, cwd) };
	if (params.reference_images?.length) {
		body.reference_images = await Promise.all(
			params.reference_images.map(async (ref) => ({ image_url: await toImageUrl(ref, cwd) })),
		);
	}
	return body;
}

function gatewaySaid(text: string): string {
	try {
		const message = (JSON.parse(text) as { error?: { message?: string } }).error?.message;
		if (message) return message;
	} catch {}
	return text.trim().slice(0, 500);
}

/** One request to the gateway, its body as bytes; throws on a network error or a refused key. */
async function call(
	root: string,
	key: string,
	method: "GET" | "POST",
	path: string,
	body: Record<string, unknown> | undefined,
	signal: AbortSignal,
): Promise<{ status: number; ok: boolean; bytes: Buffer }> {
	let response: Response;
	try {
		response = await fetch(root + path, {
			method,
			headers: {
				"User-Agent": USER_AGENT,
				...(body ? { "Content-Type": "application/json" } : {}),
				...(key ? { Authorization: `Bearer ${key}` } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
			signal,
		});
	} catch (error) {
		if (signal.aborted) throw signal.reason ?? error;
		throw new Error(`cannot reach ${root}`, { cause: error });
	}
	const bytes = Buffer.from(await response.arrayBuffer());
	if (response.status === 401 || response.status === 403) {
		throw new Error(`gateway key rejected (HTTP ${response.status}): ${gatewaySaid(bytes.toString())}`);
	}
	return { status: response.status, ok: response.ok, bytes };
}

function withTimeout(ms: number, signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(ms);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function requestImages(
	root: string,
	key: string,
	endpoint: string,
	body: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<ImageResponse> {
	const res = await call(root, key, "POST", endpoint, body, withTimeout(IMAGE_TIMEOUT_MS, signal));
	const text = res.bytes.toString();
	if (!res.ok) throw new Error(`Magpie HTTP ${res.status}: ${gatewaySaid(text)}`);
	let out: ImageResponse = {};
	try {
		out = JSON.parse(text) as ImageResponse;
	} catch {}
	if (!out.data?.length) throw new Error("Magpie returned no image");
	return out;
}

const sleep = (ms: number, signal: AbortSignal) =>
	new Promise<void>((done, fail) => {
		const timer = setTimeout(done, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				fail(signal.reason);
			},
			{ once: true },
		);
	});

/** Starts a video, waits until it is made, and returns the job with the video's bytes. */
export async function requestVideo(
	root: string,
	key: string,
	body: Record<string, unknown>,
	options: { signal?: AbortSignal; pollMs?: number; timeoutMs?: number; onStatus?: (job: VideoJob) => void } = {},
): Promise<{ job: VideoJob; video: Buffer }> {
	const signal = withTimeout(options.timeoutMs ?? VIDEO_TIMEOUT_MS, options.signal);
	const parse = (text: string): VideoJob => {
		try {
			return JSON.parse(text) as VideoJob;
		} catch {
			return {};
		}
	};
	const started = await call(root, key, "POST", "/v1/videos", body, signal);
	if (!started.ok) throw new Error(`Magpie HTTP ${started.status}: ${gatewaySaid(started.bytes.toString())}`);
	let job = parse(started.bytes.toString());
	const id = job.id;
	if (!id) throw new Error(`Magpie gave the video no id: ${gatewaySaid(started.bytes.toString())}`);
	try {
		while (job.status !== "completed") {
			if (job.status === "failed") throw new Error(`the video failed: ${job.error?.message || "Magpie gave no reason"}`);
			options.onStatus?.(job);
			await sleep(options.pollMs ?? VIDEO_POLL_MS, signal);
			const polled = await call(root, key, "GET", `/v1/videos/${id}`, undefined, signal);
			if (!polled.ok) throw new Error(`asking after video ${id}: HTTP ${polled.status}: ${gatewaySaid(polled.bytes.toString())}`);
			const next = parse(polled.bytes.toString());
			job = { ...next, model: next.model || job.model };
		}
		const content = await call(root, key, "GET", `/v1/videos/${id}/content`, undefined, signal);
		if (!content.ok) throw new Error(`fetching video ${id}: HTTP ${content.status}: ${gatewaySaid(content.bytes.toString())}`);
		if (!sniffMime(content.bytes, "").startsWith("video/")) throw new Error(`what came back for video ${id} is not a video`);
		return { job: { ...job, id }, video: content.bytes };
	} catch (error) {
		if (options.signal?.aborted) throw error;
		if (signal.aborted) {
			throw new Error(`video ${id} was not ready after ${Math.round((options.timeoutMs ?? VIDEO_TIMEOUT_MS) / 60_000)} min; Magpie may still finish it at GET /v1/videos/${id}/content`);
		}
		throw error;
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/** `path`, or `stem-2.ext`, `stem-3.ext`… when it is taken. Never overwrites. */
export async function freePath(path: string): Promise<string> {
	if (!(await exists(path))) return path;
	const ext = extname(path);
	const stem = path.slice(0, path.length - ext.length);
	for (let i = 2; ; i++) {
		const candidate = `${stem}-${i}${ext}`;
		if (!(await exists(candidate))) return candidate;
	}
}

/** The bytes' own type over what the vendor says: a model asked for PNG may send JPEG. */
export function sniffMime(buf: Uint8Array, fallback: string): string {
	if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
	if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
	if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
	if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
		return "image/webp";
	}
	if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return "video/mp4";
	if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "video/webm";
	return fallback;
}

function stamp(now: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/**
 * Where `path` says to save: a folder (one that exists, ends in `/` or has no extension) or a file.
 * A file's own media extension is dropped so the saved file is named for what it is; any other is kept
 * in the stem (`hero.v2` becomes `hero.v2.png`).
 */
async function placeOf(cwd: string, path: string | undefined, folder: string): Promise<{ dir: string; stem?: string }> {
	if (!path) return { dir: join(cwd, folder) };
	const target = resolve(cwd, path);
	const isDir = await stat(target).then((s) => s.isDirectory(), () => false);
	const ext = extname(target).toLowerCase();
	if (isDir || /[\\/]$/.test(path) || !ext) return { dir: target };
	const stem = EXT_MIME[ext] || VIDEO_EXTS.has(ext) ? basename(target, extname(target)) : basename(target);
	return { dir: dirname(target), stem };
}

/** Writes the returned images under cwd (IMAGE_FOLDER/ or `path`) and says where. */
export async function saveImages(
	out: ImageResponse,
	cwd: string,
	path?: string,
	options: { signal?: AbortSignal; now?: Date } = {},
): Promise<Saved> {
	const place = await placeOf(cwd, path, IMAGE_FOLDER);
	const base = place.stem ?? `image-${stamp(options.now ?? new Date())}`;
	const askedExt = path ? extname(path).toLowerCase() : "";
	await mkdir(place.dir, { recursive: true });

	const data = out.data ?? [];
	const files: string[] = [];
	const notes: string[] = [];
	for (const [i, item] of data.entries()) {
		let buf: Buffer;
		let mime = item.mime_type || "image/png";
		if (item.b64_json) {
			buf = Buffer.from(item.b64_json, "base64");
		} else if (item.url) {
			try {
				const res = await fetch(item.url, { signal: options.signal });
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				mime = res.headers.get("content-type")?.split(";")[0] || mime;
				buf = Buffer.from(await res.arrayBuffer());
			} catch (error) {
				notes.push(`image ${i + 1} was drawn but could not be downloaded (${String(error)}); it is at ${item.url} for a while`);
				continue;
			}
		} else {
			continue;
		}
		mime = sniffMime(buf, mime);
		const ext = MIME_EXT[mime] ?? ".png";
		const suffix = data.length > 1 ? `-${i + 1}` : "";
		const file = await freePath(join(place.dir, `${base}${suffix}${ext}`));
		await writeFile(file, buf);
		files.push(file);
		if (EXT_MIME[askedExt] && EXT_MIME[askedExt] !== mime) notes.push(`image ${i + 1} came back as ${mime}, saved as ${ext}`);
		if (item.revised_prompt) notes.push(`image ${i + 1} revised prompt: ${item.revised_prompt}`);
	}
	if (!files.length) throw new Error(`no image saved${notes.length ? `: ${notes.join("; ")}` : ""}`);
	if (out.text?.trim()) notes.push(`the model said: ${out.text.trim()}`);
	return { files, notes };
}

/** Writes a made video under cwd (VIDEO_FOLDER/ or `path`) and returns its path. */
export async function saveVideo(video: Buffer, cwd: string, path?: string, now?: Date): Promise<string> {
	const place = await placeOf(cwd, path, VIDEO_FOLDER);
	const base = place.stem ?? `video-${stamp(now ?? new Date())}`;
	await mkdir(place.dir, { recursive: true });
	const file = await freePath(join(place.dir, `${base}${MIME_EXT[sniffMime(video, "video/mp4")] ?? ".mp4"}`));
	await writeFile(file, video);
	return file;
}
