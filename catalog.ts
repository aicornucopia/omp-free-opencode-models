import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";

// Wire format returned by https://opencode.ai/zen/v1/models.
interface ZenModel {
  id: string;
  name: string;
  type: string;
  modalities?: { input?: string[]; output?: string[] };
  capabilities?: { reasoning?: { supported?: boolean } };
  limit?: { context?: number; output?: number };
  cost?: Record<string, {
    input?: { price?: number; cache?: { read?: number; write?: number } };
    output?: { price?: number };
  }>;
  api?: Record<string, {
    base_url?: string;
    compatibility?: { reasoning_field?: string };
  }>;
}

export const BASE_URL = "https://opencode.ai/inference/openai/v1";
export const CATALOG_URL = "https://opencode.ai/zen/v1/models";

export function freeModels(catalog: { data: ZenModel[] }): ProviderModelConfig[] {
  return catalog.data.flatMap((model): ProviderModelConfig[] => {
    // Missing prices are unknown, not free. Check non-text modalities and cache prices too.
    if (model.cost?.text?.input?.price !== 0 || model.cost.text.output?.price !== 0) return [];
    if (Object.values(model.cost).some((cost) =>
      (cost.input !== undefined && cost.input.price !== 0) ||
      (cost.output !== undefined && cost.output.price !== 0) ||
      (cost.input?.cache?.read ?? 0) !== 0 || (cost.input?.cache?.write ?? 0) !== 0
    )) return [];
    if (model.type !== "chat" || !model.modalities?.input?.includes("text")) return [];
    if (!model.modalities.output?.includes("text")) return [];
    if (!model.limit?.context || !model.limit.output) return [];

    const chat = model.api?.["chat-completions"];
    const responses = model.api?.responses;
    const route = chat ?? responses;
    // Do not route a model to a different endpoint than the one its catalog advertises.
    if (route?.base_url !== BASE_URL) return [];
    const reasoningField = route.compatibility?.reasoning_field;
    if (reasoningField !== undefined && reasoningField !== "reasoning_content" &&
      reasoningField !== "reasoning" && reasoningField !== "reasoning_text") return [];

    return [{
      id: model.id,
      name: model.name,
      api: chat ? "openai-completions" : "openai-responses",
      reasoning: model.capabilities?.reasoning?.supported === true,
      input: model.modalities.input.some((modality) => modality === "image" || modality.startsWith("image/"))
        ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.limit.context,
      maxTokens: model.limit.output,
      // OMP's Big Pickle → DeepSeek alias is scoped to opencode-zen. Our provider
      // must preserve that exact replay contract; upstream rejects invented traces.
      compat: chat && model.id === "big-pickle" && model.capabilities?.reasoning?.supported ? {
        reasoningContentField: "reasoning_content",
        requiresReasoningContentForToolCalls: true,
        requiresReasoningContentForAllAssistantTurns: true,
        allowsSyntheticReasoningContentForToolCalls: false,
      } : chat && reasoningField ? {
        reasoningContentField: reasoningField,
      } : undefined,
    }];
  });
}
