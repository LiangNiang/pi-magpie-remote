import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeMagpieUrl } from "./magpie.ts";
import {
	buildImageRequest,
	buildVideoRequest,
	IMAGE_FOLDER,
	requestImages,
	requestVideo,
	saveImages,
	saveVideo,
	VIDEO_FOLDER,
} from "./media.ts";

/** The gateway address and key the provider's /login saved. */
async function gatewayOf(ctx: ExtensionContext, provider: string): Promise<{ root: string; key: string }> {
	const model = ctx.modelRegistry.getAll().find((m) => m.provider === provider);
	if (!model) throw new Error("not logged in to Magpie (remote) — run /login first");
	const key = (await ctx.modelRegistry.getApiKeyForProvider(provider)) ?? "";
	return { root: normalizeMagpieUrl(model.baseUrl), key };
}

const envModel = (name: string) => process.env[name]?.trim() || undefined;

export function registerMediaTools(pi: ExtensionAPI, provider: string): void {
	pi.registerTool(
		defineTool({
			name: "generate_image",
			label: "Generate image",
			description:
				"Generate an image from a text prompt, or edit/combine images given as reference_images, with an image model of the remote Magpie gateway. " +
				`The file is saved in the project (${IMAGE_FOLDER}/ unless path says where) and its path is returned; the image itself is not shown. Takes 20-90 s. ` +
				"Write a detailed prompt: subject, style, composition, colours, any text to render exactly.",
			parameters: Type.Object({
				prompt: Type.String({ description: "What to draw, or how to change the reference images." }),
				path: Type.Optional(
					Type.String({
						description:
							"Where to save: a file (e.g. assets/hero.png) or a folder, relative to cwd or absolute. Never overwritten; with n > 1 a number is added. The extension follows the format the model returns.",
					}),
				),
				size: Type.Optional(
					Type.String({
						description: "WIDTHxHEIGHT (1024x1024, 1536x1024, 1024x1536), an aspect ratio (16:9) or auto. Default: the model's.",
					}),
				),
				n: Type.Optional(Type.Integer({ minimum: 1, maximum: 4, description: "How many images (default 1)." })),
				quality: Type.Optional(Type.String({ description: "low, medium, high or auto, for models that take it." })),
				background: Type.Optional(Type.String({ description: "transparent, opaque or auto, for models that take it." })),
				model: Type.Optional(
					Type.String({ description: "Image model id on the gateway, e.g. codex/gpt-image-2. Usually omit: Magpie picks." }),
				),
				reference_images: Type.Optional(
					Type.Array(Type.String(), { description: "Images to edit or draw from: file paths or http(s)/data URLs." }),
				),
			}),

			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				const { root, key } = await gatewayOf(ctx, provider);
				const { endpoint, body } = await buildImageRequest(params, ctx.cwd, envModel("PI_MAGPIE_IMAGE_MODEL"));
				onUpdate?.({ content: [{ type: "text", text: `Drawing with Magpie (${root})…` }], details: undefined });
				const out = await requestImages(root, key, endpoint, body, signal);
				const { files, notes } = await saveImages(out, ctx.cwd, params.path, { signal });
				const text = [`Saved ${files.length} image(s) with ${out.model ?? "magpie"}:`, ...files, ...notes].join("\n");
				return { content: [{ type: "text", text }], details: { model: out.model, files } };
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "generate_video",
			label: "Generate video",
			description:
				"Generate a short video from a text prompt, optionally animating an image, with a video model of the remote Magpie gateway. " +
				`It takes from ten seconds to a few minutes; the video is saved in the project (${VIDEO_FOLDER}/ unless path says where) and its path is returned. ` +
				"Describe the subject, the motion and the camera: what moves, how, and what the shot is.",
			parameters: Type.Object({
				prompt: Type.String({ description: "What happens in the video: the subject, its motion, the camera." }),
				path: Type.Optional(
					Type.String({
						description: "Where to save: a file (e.g. assets/intro.mp4) or a folder, relative to cwd or absolute. Never overwritten.",
					}),
				),
				seconds: Type.Optional(
					Type.Integer({ minimum: 1, maximum: 15, description: "Length in whole seconds (1-15). Default: the model's." }),
				),
				size: Type.Optional(
					Type.String({
						description:
							"An aspect ratio (16:9, 9:16, 1:1, 4:3, 3:4, 3:2, 2:3) or WIDTHxHEIGHT (1280x720; its shorter side picks 480p, 720p or 1080p). Default: the model's.",
					}),
				),
				model: Type.Optional(
					Type.String({ description: "Video model id on the gateway, e.g. grok/grok-imagine-video. Usually omit: Magpie picks." }),
				),
				image: Type.Optional(
					Type.String({ description: "An image to animate, the video's first frame: a file path or an http(s)/data URL." }),
				),
				reference_images: Type.Optional(
					Type.Array(Type.String(), { description: "Images the video's subjects are drawn from: file paths or http(s)/data URLs." }),
				),
			}),

			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				const { root, key } = await gatewayOf(ctx, provider);
				const body = await buildVideoRequest(params, ctx.cwd, envModel("PI_MAGPIE_VIDEO_MODEL"));
				const started = Date.now();
				const say = (text: string) => onUpdate?.({ content: [{ type: "text", text }], details: undefined });
				say(`Filming with Magpie (${root})…`);
				const { job, video } = await requestVideo(root, key, body, {
					signal,
					onStatus: (j) => {
						const progress = typeof j.progress === "number" && j.progress > 0 ? `, ${j.progress}%` : "";
						say(`Video ${j.id ?? ""} ${j.status ?? "queued"}${progress} (${Math.round((Date.now() - started) / 1000)} s)…`);
					},
				});
				const file = await saveVideo(video, ctx.cwd, params.path);
				const length = job.seconds ? `${job.seconds}-second ` : "";
				const text = `Saved a ${length}video with ${job.model ?? "magpie"}:\n${file}`;
				return { content: [{ type: "text", text }], details: { model: job.model, id: job.id, files: [file] } };
			},
		}),
	);
}
