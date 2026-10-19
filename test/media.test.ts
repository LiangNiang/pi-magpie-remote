import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	buildImageRequest,
	buildVideoRequest,
	freePath,
	IMAGE_FOLDER,
	requestImages,
	requestVideo,
	saveImages,
	saveVideo,
	sniffMime,
	USER_AGENT,
	VIDEO_FOLDER,
} from "../media.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const MP4 = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

async function tempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pmr-media-"));
}

async function startServer(
	handle: (request: IncomingMessage, body: string, response: ServerResponse) => void,
): Promise<{ root: string; server: Server }> {
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		handle(request, body, response);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	return { root: `http://127.0.0.1:${address.port}`, server };
}

async function closeServer(server: Server): Promise<void> {
	server.close();
	await once(server, "close");
}

function json(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(value));
}

test("buildImageRequest: generations by default, clamps n, passes options and default model", async () => {
	const { endpoint, body } = await buildImageRequest({ prompt: "cat", n: 9, size: "16:9", quality: "low" }, "/", "codex/gpt-image-2");
	assert.equal(endpoint, "/v1/images/generations");
	assert.deepEqual(body, {
		prompt: "cat",
		n: 4,
		response_format: "b64_json",
		model: "codex/gpt-image-2",
		size: "16:9",
		quality: "low",
	});
	const explicit = await buildImageRequest({ prompt: "cat", model: "x/y" }, "/", "codex/gpt-image-2");
	assert.equal(explicit.body.model, "x/y");
	const none = await buildImageRequest({ prompt: "cat" }, "/");
	assert.equal("model" in none.body, false);
	await assert.rejects(buildImageRequest({ prompt: "  " }, "/"), /prompt is required/);
});

test("buildImageRequest: reference images switch to edits; files become data URLs", async () => {
	const dir = await tempDir();
	try {
		await writeFile(join(dir, "ref.png"), PNG);
		await writeFile(join(dir, "shot"), JPEG);
		const { endpoint, body } = await buildImageRequest(
			{ prompt: "edit", reference_images: ["ref.png", "shot", "https://x/y.jpg"] },
			dir,
		);
		assert.equal(endpoint, "/v1/images/edits");
		assert.deepEqual(body.images, [
			{ image_url: `data:image/png;base64,${PNG.toString("base64")}` },
			{ image_url: `data:image/jpeg;base64,${JPEG.toString("base64")}` },
			{ image_url: "https://x/y.jpg" },
		]);
		await writeFile(join(dir, "notes.txt"), "x");
		await assert.rejects(buildImageRequest({ prompt: "e", reference_images: ["notes.txt"] }, dir), /not png/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("buildVideoRequest: seconds as a string, first frame and references, default model", async () => {
	const dir = await tempDir();
	try {
		await writeFile(join(dir, "start.png"), PNG);
		const body = await buildVideoRequest(
			{ prompt: "waves", seconds: 6, size: "16:9", image: "start.png", reference_images: ["https://x/y.jpg"] },
			dir,
			"grok/grok-imagine-video",
		);
		assert.deepEqual(body, {
			prompt: "waves",
			model: "grok/grok-imagine-video",
			seconds: "6",
			size: "16:9",
			input_reference: { image_url: `data:image/png;base64,${PNG.toString("base64")}` },
			reference_images: [{ image_url: "https://x/y.jpg" }],
		});
		assert.deepEqual(await buildVideoRequest({ prompt: "waves" }, dir), { prompt: "waves" });
		await assert.rejects(buildVideoRequest({ prompt: "w", seconds: 1.5 }, dir), /whole number/);
		await assert.rejects(buildVideoRequest({ prompt: "" }, dir), /prompt is required/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("requestImages sends the key and User-Agent, parses data, reports HTTP errors", async () => {
	let seen: { auth?: string; ua?: string; url?: string } = {};
	const { root, server } = await startServer((request, body, response) => {
		seen = { auth: request.headers.authorization, ua: request.headers["user-agent"], url: request.url };
		if (request.headers.authorization !== "Bearer good") return json(response, 403, { error: { message: "bad key" } });
		if (JSON.parse(body).prompt === "fail") return json(response, 502, { error: { message: "vendor down" } });
		json(response, 200, { model: "codex/gpt-image-2", data: [{ b64_json: PNG.toString("base64") }] });
	});
	try {
		const out = await requestImages(root, "good", "/v1/images/generations", { prompt: "cat" });
		assert.equal(out.model, "codex/gpt-image-2");
		assert.deepEqual(seen, { auth: "Bearer good", ua: USER_AGENT, url: "/v1/images/generations" });
		assert.match(USER_AGENT, / magpie-image\/1$/);
		await assert.rejects(requestImages(root, "bad", "/v1/images/generations", { prompt: "cat" }), /key rejected.*bad key/);
		await assert.rejects(requestImages(root, "good", "/v1/images/generations", { prompt: "fail" }), /HTTP 502: vendor down/);
	} finally {
		await closeServer(server);
	}
});

test("sniffMime trusts the bytes", () => {
	assert.equal(sniffMime(JPEG, "image/png"), "image/jpeg");
	assert.equal(sniffMime(PNG, "image/jpeg"), "image/png");
	assert.equal(sniffMime(MP4, ""), "video/mp4");
	assert.equal(sniffMime(Buffer.from("hello world!"), "image/png"), "image/png");
});

test("freePath never overwrites", async () => {
	const dir = await tempDir();
	try {
		const p = join(dir, "a.png");
		assert.equal(await freePath(p), p);
		await writeFile(p, "x");
		assert.equal(await freePath(p), join(dir, "a-2.png"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("saveImages: default folder, file path, folder path, numbering", async () => {
	const dir = await tempDir();
	const now = new Date(2026, 0, 2, 3, 4, 5);
	try {
		const png = { data: [{ b64_json: PNG.toString("base64") }] };
		const a = await saveImages(png, dir, undefined, { now });
		assert.deepEqual(a.files, [join(dir, IMAGE_FOLDER, "image-20260102-030405.png")]);

		const b = await saveImages(png, dir, "assets/hero.png");
		assert.deepEqual(b.files, [join(dir, "assets", "hero.png")]);
		assert.deepEqual(b.notes, []);
		const b2 = await saveImages(png, dir, "assets/hero.png");
		assert.deepEqual(b2.files, [join(dir, "assets", "hero-2.png")]);

		const two = { data: [{ b64_json: PNG.toString("base64") }, { b64_json: PNG.toString("base64"), revised_prompt: "r" }] };
		const c = await saveImages(two, dir, "out", { now });
		assert.deepEqual(c.files, [join(dir, "out", "image-20260102-030405-1.png"), join(dir, "out", "image-20260102-030405-2.png")]);
		assert.deepEqual(c.notes, ["image 2 revised prompt: r"]);
		assert.deepEqual(await readFile(c.files[0]!), PNG);
		assert.equal((await readdir(join(dir, "out"))).length, 2);

		await mkdir(join(dir, "pics.d"));
		const d = await saveImages(png, dir, "pics.d", { now });
		assert.deepEqual(d.files, [join(dir, "pics.d", "image-20260102-030405.png")]);
		const e = await saveImages(png, dir, "assets/hero.v2");
		assert.deepEqual(e.files, [join(dir, "assets", "hero.v2.png")]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("saveImages names a file for what the model sent, and keeps what it said", async () => {
	const dir = await tempDir();
	try {
		const jpeg = { text: " here you go ", data: [{ b64_json: JPEG.toString("base64"), mime_type: "image/png" }] };
		const out = await saveImages(jpeg, dir, "assets/hero.png");
		assert.deepEqual(out.files, [join(dir, "assets", "hero.jpg")]);
		assert.deepEqual(out.notes, ["image 1 came back as image/jpeg, saved as .jpg", "the model said: here you go"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("saveImages downloads URL results and fails when nothing is saved", async () => {
	const dir = await tempDir();
	const { root, server } = await startServer((request, _body, response) => {
		if (request.url === "/ok.png") {
			response.writeHead(200, { "content-type": "image/png" });
			response.end(PNG);
		} else {
			response.writeHead(404);
			response.end();
		}
	});
	try {
		const ok = await saveImages({ data: [{ url: `${root}/ok.png` }] }, dir, "u.png");
		assert.deepEqual(ok.files, [join(dir, "u.png")]);
		await assert.rejects(saveImages({ data: [{ url: `${root}/gone.png` }] }, dir), /no image saved.*could not be downloaded/);
	} finally {
		await closeServer(server);
		await rm(dir, { recursive: true, force: true });
	}
});

test("requestVideo starts, polls until completed and downloads the video", async () => {
	const seen: string[] = [];
	let polls = 0;
	const { root, server } = await startServer((request, body, response) => {
		seen.push(`${request.method} ${request.url} ${request.headers["user-agent"]}`);
		if (request.method === "POST" && request.url === "/v1/videos") {
			assert.deepEqual(JSON.parse(body), { prompt: "waves" });
			return json(response, 200, { id: "vid_1", status: "queued", model: "grok/grok-imagine-video" });
		}
		if (request.url === "/v1/videos/vid_1") {
			polls++;
			return json(response, 200, polls < 2 ? { id: "vid_1", status: "in_progress", progress: 40 } : { id: "vid_1", status: "completed", seconds: "6" });
		}
		if (request.url === "/v1/videos/vid_1/content") {
			response.writeHead(200, { "content-type": "video/mp4" });
			return response.end(MP4);
		}
		response.writeHead(404);
		response.end();
	});
	try {
		const statuses: string[] = [];
		const { job, video } = await requestVideo(root, "k", { prompt: "waves" }, { pollMs: 1, onStatus: (j) => statuses.push(j.status ?? "") });
		assert.deepEqual(job, { id: "vid_1", status: "completed", seconds: "6", model: "grok/grok-imagine-video" });
		assert.deepEqual(video, MP4);
		assert.deepEqual(statuses, ["queued", "in_progress"]);
		assert.deepEqual(seen, [
			`POST /v1/videos ${USER_AGENT}`,
			`GET /v1/videos/vid_1 ${USER_AGENT}`,
			`GET /v1/videos/vid_1 ${USER_AGENT}`,
			`GET /v1/videos/vid_1/content ${USER_AGENT}`,
		]);
	} finally {
		await closeServer(server);
	}
});

test("requestVideo reports a failed video, a non-video body and a timeout", async () => {
	const { root, server } = await startServer((request, body, response) => {
		const prompt = request.method === "POST" ? JSON.parse(body).prompt : "";
		if (request.method === "POST") return json(response, 200, { id: prompt, status: "queued" });
		if (request.url === "/v1/videos/fail") return json(response, 200, { status: "failed", error: { message: "moderated" } });
		if (request.url === "/v1/videos/text") return json(response, 200, { status: "completed" });
		if (request.url === "/v1/videos/text/content") return json(response, 200, { not: "a video" });
		json(response, 200, { status: "in_progress" });
	});
	try {
		await assert.rejects(requestVideo(root, "k", { prompt: "fail" }, { pollMs: 1 }), /the video failed: moderated/);
		await assert.rejects(requestVideo(root, "k", { prompt: "text" }, { pollMs: 1 }), /is not a video/);
		await assert.rejects(requestVideo(root, "k", { prompt: "slow" }, { pollMs: 5, timeoutMs: 50 }), /video slow was not ready/);
	} finally {
		await closeServer(server);
	}
});

test("saveVideo: default folder and a file path, never overwritten", async () => {
	const dir = await tempDir();
	try {
		const a = await saveVideo(MP4, dir, undefined, new Date(2026, 0, 2, 3, 4, 5));
		assert.equal(a, join(dir, VIDEO_FOLDER, "video-20260102-030405.mp4"));
		assert.equal(await saveVideo(MP4, dir, "clips/intro.mov"), join(dir, "clips", "intro.mp4"));
		assert.equal(await saveVideo(MP4, dir, "clips/intro.mp4"), join(dir, "clips", "intro-2.mp4"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
