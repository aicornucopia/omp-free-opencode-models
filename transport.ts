import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model, SimpleStreamOptions, ToolChoice } from "@oh-my-pi/pi-ai";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { OpenAICompat } from "@oh-my-pi/pi-catalog/types";
import { environment, OpenCodeClient } from "./client.ts";

export const CHAT_API = "opencode-free-chat";
export const RESPONSES_API = "opencode-free-responses";
type NativeModel = Model<"openai-completions"> | Model<"openai-responses">;

function nativeModel(model: Model<Api>): NativeModel {
  // Reuse OMP's reviewed OpenCode policies without exposing that provider's auth.
  const spec = { ...model, provider: "opencode-zen", compat: model.compatConfig as OpenAICompat | undefined, remoteCompaction: undefined };
  if (model.api === CHAT_API) return buildModel<"openai-completions">({ ...spec, api: "openai-completions" });
  if (model.api === RESPONSES_API) return buildModel<"openai-responses">({ ...spec, api: "openai-responses" });
  throw new Error(`Unsupported OpenCode transport: ${model.api}`);
}

function toolChoice(choice: ToolChoice | undefined, alias: boolean): "auto" | "none" | "required" | { type: "function"; function: { name: string } } | undefined {
  if (choice === undefined || choice === "auto" || choice === "none" || choice === "required") return choice;
  if (choice === "any") return "required";
  if (choice.type === "computer") throw new Error("OpenCode free models do not expose a native computer tool");
  const name = "function" in choice ? choice.function.name : choice.name;
  return { type: "function", function: { name: alias && name === "bash" ? "shell" : name } };
}

function adaptToolsAndHistory(model: Model<Api>, native: NativeModel, context: Context, choice?: ToolChoice) {
  const alias = context.tools?.some((tool) => tool.name === "bash") === true &&
    !context.tools?.some((tool) => tool.name === "shell");
  const wireContext: Context = {
    ...context,
    tools: alias ? context.tools?.map((tool) => tool.name === "bash" ? { ...tool, name: "shell" } : tool) : context.tools,
    messages: context.messages.map((message) => {
      if (message.role === "assistant") {
        const own = message.provider === model.provider && message.model === model.id &&
          (message.api === model.api || message.api === native.api);
        return {
          ...message,
          provider: own ? native.provider : message.provider,
          api: own ? native.api : message.api,
          content: alias ? message.content.map((part) => part.type === "toolCall" && part.name === "bash"
            ? { ...part, name: "shell" } : part) : message.content,
        };
      }
      return alias && message.role === "toolResult" && message.toolName === "bash"
        ? { ...message, toolName: "shell" } : message;
    }),
  };
  function restore(message: AssistantMessage): AssistantMessage {
    return {
      ...message,
      provider: model.provider,
      api: model.api,
      content: alias ? message.content.map((part) => part.type === "toolCall" && part.name === "shell"
        ? { ...part, name: "bash" } : part) : message.content,
    };
  }
  return {
    context: wireContext,
    toolChoice: toolChoice(choice, alias),
    restoreEvent(event: AssistantMessageEvent): AssistantMessageEvent {
      // The native parser owns partials shared with later events and its final
      // result. Restore tool names only in detached terminal snapshots.
      if (event.type === "toolcall_end") {
        const partial = restore(event.partial);
        const toolCall = alias && event.toolCall.name === "shell" ? { ...event.toolCall, name: "bash" } : event.toolCall;
        return { ...event, partial, toolCall };
      }
      if (event.type === "done") return { ...event, message: restore(event.message) };
      if (event.type === "error") return { ...event, error: restore(event.error) };
      return event;
    },
  };
}

export function createTransport(client: OpenCodeClient) {
  const models = new WeakMap<Model<Api>, NativeModel>();
  return (model: Model<Api>, context: Context, options: SimpleStreamOptions = {}): AssistantMessageEventStream => {
    let native = models.get(model);
    if (!native) { native = nativeModel(model); models.set(model, native); }
    const workspace = client.workspace(options.cwd ?? process.cwd());
    if (!options.sessionId) throw new Error("OpenCode request is missing OMP session attribution");
    const sessionId = options.sessionId;
    const adapter = adaptToolsAndHistory(model, native, context, options.toolChoice);
    const wireContext: Context = {
      ...adapter.context,
      systemPrompt: [...(adapter.context.systemPrompt ?? []), environment(workspace)],
    };
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const nativeOptions = {
      ...options,
      apiKey: "public",
      disableReasoning: options.disableReasoning || options.forceReasoningOff,
      toolChoice: adapter.toolChoice,
      maxTokensExplicit: options.maxTokens !== undefined,
      reasoningSummary: options.hideThinkingSummary ? null : undefined,
      fetch: ((input, init) => {
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        for (const [name, value] of Object.entries(client.headers(sessionId, workspace))) headers.set(name, value);
        return fetchImpl(input, { ...init, headers, redirect: "error" });
      }) as typeof fetchImpl,
    };
    // Delegate directly, rather than re-entering streamSimple and acquiring the
    // same provider's concurrency permit a second time.
    const source = native.api === "openai-completions"
      ? streamOpenAICompletions(native, wireContext, nativeOptions)
      : streamOpenAIResponses(native, wireContext, nativeOptions);
    const output = new AssistantMessageEventStream();
    void (async () => {
      for await (const event of source) output.push(adapter.restoreEvent(event));
      await source.result();
      output.end();
    })().catch((error: unknown) => output.fail(error));
    return output;
  };
}
