import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
  ToolChoice,
} from "@oh-my-pi/pi-ai";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { OpenAICompat } from "@oh-my-pi/pi-catalog/types";
import { environment, OpenCodeClient } from "./client.ts";

export const CHAT_API = "opencode-free-chat";
export const RESPONSES_API = "opencode-free-responses";
type NativeModel = Model<"openai-completions"> | Model<"openai-responses">;

/** OMP's shell tool, and the name OpenCode's own CLI asks for it under. */
const OMP_SHELL_TOOL = "bash";
const WIRE_SHELL_TOOL = "shell";

/** Tool choice as the native OpenAI handlers take it: `any` folds to `required`. */
type WireToolChoice = "auto" | "none" | "required" | { type: "function"; function: { name: string } };

/** A request in OpenCode's terms, plus the way back for the reply. */
interface AdaptedRequest {
  readonly context: Context;
  readonly toolChoice: WireToolChoice | undefined;
  /** A reply event carrying OMP's own identity and tool names again. */
  restore(event: AssistantMessageEvent): AssistantMessageEvent;
}

function nativeModel(model: Model<Api>): NativeModel {
  // Reuse OMP's reviewed OpenCode policies without exposing that provider's auth:
  // the catalog keys compat rules by provider, and the provider id is the whole
  // lookup key for the OpenCode-specific replay and tool-choice rules.
  const spec = {
    ...model,
    provider: "opencode-zen",
    compat: model.compatConfig as OpenAICompat | undefined,
    remoteCompaction: undefined,
  };
  if (model.api === CHAT_API) return buildModel<"openai-completions">({ ...spec, api: "openai-completions" });
  if (model.api === RESPONSES_API) return buildModel<"openai-responses">({ ...spec, api: "openai-responses" });
  throw new Error(`Unsupported OpenCode transport: ${model.api}`);
}

/**
 * Whether OMP's `bash` has to go to the wire as OpenCode's `shell`.
 *
 * OpenCode's free tier reads a request as its own CLI's, and that CLI's shell
 * tool is named `shell`; OMP implements the same capability as `bash`. Rename
 * only when OMP really offers `bash` — otherwise the wire would name a tool the
 * session cannot run — and when nothing already claims `shell`, since renaming
 * would shadow that tool and make a returned call ambiguous.
 */
function presentsBashAsShell(context: Context): boolean {
  return (
    context.tools?.some((tool) => tool.name === OMP_SHELL_TOOL) === true &&
    !context.tools?.some((tool) => tool.name === WIRE_SHELL_TOOL)
  );
}

/** OMP's tool name as OpenCode's wire expects it. */
function wireToolName(name: string, aliasing: boolean): string {
  return aliasing && name === OMP_SHELL_TOOL ? WIRE_SHELL_TOOL : name;
}

/** The OMP tool a wire name refers to. */
function ompToolName(name: string, aliasing: boolean): string {
  return aliasing && name === WIRE_SHELL_TOOL ? OMP_SHELL_TOOL : name;
}

function wireToolChoice(choice: ToolChoice | undefined, aliasing: boolean): WireToolChoice | undefined {
  if (choice === undefined || choice === "auto" || choice === "none" || choice === "required") return choice;
  if (choice === "any") return "required";
  // No native computer tool is offered here, so a forced one could never run.
  if (choice.type === "computer") throw new Error("OpenCode free models do not expose a native computer tool");
  return {
    type: "function",
    function: { name: wireToolName("function" in choice ? choice.function.name : choice.name, aliasing) },
  };
}

/** The transcript as OpenCode's wire needs it; see the decisions in the callers. */
function toWireMessages(
  model: Model<Api>,
  native: NativeModel,
  messages: Context["messages"],
  aliasing: boolean,
): Context["messages"] {
  return messages.map((message) => {
    if (message.role !== "assistant") {
      return aliasing && message.role === "toolResult" && message.toolName === OMP_SHELL_TOOL
        ? { ...message, toolName: WIRE_SHELL_TOOL }
        : message;
    }
    // OMP's formatter picks the reasoning replay policy from a turn's own
    // provider/api, and this provider's rules differ from the OpenCode ones
    // resolved above. Swap identity only on turns this provider produced, and
    // only for the wire: replies are restored before the caller sees them.
    const own =
      message.provider === model.provider &&
      message.model === model.id &&
      (message.api === model.api || message.api === native.api);
    return {
      ...message,
      provider: own ? native.provider : message.provider,
      api: own ? native.api : message.api,
      content: aliasing
        ? message.content.map((part) => {
            if (part.type !== "toolCall") return part;
            const name = wireToolName(part.name, aliasing);
            return name === part.name ? part : { ...part, name };
          })
        : message.content,
    };
  });
}

function toWireContext(model: Model<Api>, native: NativeModel, context: Context, aliasing: boolean): Context {
  return {
    ...context,
    tools: aliasing
      ? context.tools?.map((tool) => {
          // Only the name changes: description, schema and arguments stay OMP's,
          // so the model is offered exactly the tool the session will execute.
          const name = wireToolName(tool.name, aliasing);
          return name === tool.name ? tool : { ...tool, name };
        })
      : context.tools,
    messages: toWireMessages(model, native, context.messages, aliasing),
  };
}

/** A reply under OMP's identity again, so a returned call reaches the tool that runs it. */
function restoreMessage(model: Model<Api>, aliasing: boolean, message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    provider: model.provider,
    api: model.api,
    content: aliasing
      ? message.content.map((part) => {
          if (part.type !== "toolCall") return part;
          const name = ompToolName(part.name, aliasing);
          return name === part.name ? part : { ...part, name };
        })
      : message.content,
  };
}

function adaptRequest(model: Model<Api>, native: NativeModel, context: Context, choice?: ToolChoice): AdaptedRequest {
  const aliasing = presentsBashAsShell(context);
  return {
    context: toWireContext(model, native, context, aliasing),
    toolChoice: wireToolChoice(choice, aliasing),
    restore(event) {
      // The native parser keeps partials that later events and its own final
      // result share, so only detached snapshots are rewritten here. Mutating a
      // partial in place would corrupt that state mid-stream.
      if (event.type === "toolcall_end") {
        const name = ompToolName(event.toolCall.name, aliasing);
        return {
          ...event,
          partial: restoreMessage(model, aliasing, event.partial),
          toolCall: name === event.toolCall.name ? event.toolCall : { ...event.toolCall, name },
        };
      }
      if (event.type === "done") return { ...event, message: restoreMessage(model, aliasing, event.message) };
      if (event.type === "error") return { ...event, error: restoreMessage(model, aliasing, event.error) };
      return event;
    },
  };
}

export function createTransport(client: OpenCodeClient) {
  const models = new WeakMap<Model<Api>, NativeModel>();
  return (model: Model<Api>, context: Context, options: SimpleStreamOptions = {}): AssistantMessageEventStream => {
    let native = models.get(model);
    if (!native) {
      native = nativeModel(model);
      models.set(model, native);
    }
    const workspace = client.workspace(options.cwd ?? process.cwd());
    if (!options.sessionId) throw new Error("OpenCode request is missing OMP session attribution");
    const sessionId = options.sessionId;
    const adapted = adaptRequest(model, native, context, options.toolChoice);
    const wireContext: Context = {
      ...adapted.context,
      // OpenCode's own prompt ends with this block, and its free tier reads the
      // request as its own CLI's. Appended last so the agent's prompt keeps its
      // shape and only the environment section is ours.
      systemPrompt: [...(adapted.context.systemPrompt ?? []), environment(workspace)],
    };
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const nativeOptions = {
      ...options,
      // The anonymous credential OpenCode itself sends when nobody is signed in.
      apiKey: "public",
      disableReasoning: options.disableReasoning || options.forceReasoningOff,
      toolChoice: adapted.toolChoice,
      maxTokensExplicit: options.maxTokens !== undefined,
      reasoningSummary: options.hideThinkingSummary ? null : undefined,
      // Every HTTP call this request makes carries OpenCode's client identity,
      // including retries inside the handler. Applying it per fetch keeps that
      // true even for a call the handler builds itself.
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
      for await (const event of source) output.push(adapted.restore(event));
      await source.result();
      output.end();
    })().catch((error: unknown) => output.fail(error));
    return output;
  };
}
