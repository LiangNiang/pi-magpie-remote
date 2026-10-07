import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loginMagpie, refreshMagpieModels, refreshMagpieToken } from "./magpie.ts";

export default function (pi: ExtensionAPI): void {
	pi.registerProvider("magpie-remote", {
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

	pi.registerCommand("magpie-sync", {
		description: "Re-fetch the remote magpie model list",
		handler: async (_args, context) => {
			const result = await context.modelRegistry.refresh({
				providers: ["magpie-remote"],
				allowNetwork: true,
				force: true,
			});
			if (result.errors.size > 0) {
				context.ui.notify([...result.errors.values()].map((error) => error.message).join("\n"), "error");
				return;
			}
			const count = context.modelRegistry.getAll().filter((model) => model.provider === "magpie-remote").length;
			context.ui.notify(`Loaded ${count} Magpie models`, "info");
		},
	});
}
