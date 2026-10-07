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
}
