import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { BASE_URL, CATALOG_URL, freeModels } from "./catalog.ts";
import { loadUserAgent, OpenCodeClient } from "./client.ts";
import { CHAT_API, createTransport, RESPONSES_API } from "./transport.ts";

export default async function opencodeFree(pi: ExtensionAPI): Promise<void> {
  const [userAgent, response] = await Promise.all([
    loadUserAgent(),
    fetch(CATALOG_URL, { signal: AbortSignal.timeout(10_000), redirect: "error" }),
  ]);
  if (!response.ok) throw new Error(`OpenCode model catalog: HTTP ${response.status}`);
  const catalog = await response.json();
  if (!Array.isArray(catalog?.data)) throw new Error("OpenCode model catalog: expected a data array");
  const models = freeModels(catalog).map((model) => ({
    ...model,
    api: model.api === "openai-responses" ? RESPONSES_API : CHAT_API,
  }));
  const streamSimple = createTransport(new OpenCodeClient(userAgent));
  pi.registerProvider("opencode-free", {
    baseUrl: BASE_URL,
    // OpenCode's signed-out provider uses "public", never a user's paid key.
    apiKey: "public",
    authHeader: true,
    headers: { "User-Agent": userAgent, "x-opencode-client": "cli" },
    api: CHAT_API,
    streamSimple,
    models,
  });
  // Register the second wire API without replacing the provider's model list.
  pi.registerProvider("opencode-free", { api: RESPONSES_API, streamSimple });
}
