import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessageEventStream, Context, Tool } from "@oh-my-pi/pi-ai";
import { Type } from "@oh-my-pi/omptype/typebox";
import { type } from "@oh-my-pi/omptype";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { BASE_URL, freeModels } from "./catalog.ts";
import { OpenCodeClient } from "./client.ts";
import { CHAT_API, createTransport, RESPONSES_API } from "./transport.ts";

const trace = " Inspect the input.\nCall the real shell. ";
const bash: Tool = { name: "bash", description: "Execute a shell command", parameters: Type.Object({ command: Type.String() }) };
const sessionId = "018f0000-0000-7000-8000-000000000001";

const CapturedPayload = type({
  "tools?": type({ "name?": "string", "function?": { name: "string" } }).array(),
  "messages?": type({
    role: "string", "content?": "unknown", "reasoning_content?": "string",
    "tool_calls?": type({ function: { name: "string" } }).array(),
  }).array(),
  "instructions?": "unknown",
  "input?": type({ "type?": "string", "role?": "string", "content?": "unknown", "name?": "string", "call_id?": "string", "output?": "unknown" }).array(),
});

function fixtureModel(api: typeof CHAT_API | typeof RESPONSES_API) {
  const [definition] = freeModels({ data: [{
    id: "big-pickle", name: "Big Pickle", type: "chat",
    modalities: { input: ["text"], output: ["text"] },
    capabilities: { reasoning: { supported: true } },
    limit: { context: 200_000, output: 32_000 },
    cost: { text: { input: { price: 0 }, output: { price: 0 } } },
    api: { "chat-completions": { base_url: BASE_URL, compatibility: { reasoning_field: "reasoning_content" } } },
  }] });
  return buildModel<Api>({ ...definition, api, provider: "opencode-free", baseUrl: BASE_URL });
}

function chatResponse(tool: boolean) {
  const deltas = tool ? [
    { role: "assistant", reasoning_content: " Inspect the input." },
    { reasoning_content: "\nCall the real shell. " },
    { tool_calls: [{ index: 0, id: "call_shell", type: "function", function: { name: "shell", arguments: '{"command":' } }] },
    { tool_calls: [{ index: 0, function: { arguments: '"printf probe"}' } }] },
  ] : [{ role: "assistant", content: "COMPLETE" }];
  const chunks = deltas.map((delta) => ({
    id: "chat_probe", object: "chat.completion.chunk", model: "big-pickle",
    choices: [{ index: 0, delta, finish_reason: null }],
  }));
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
    `data: ${JSON.stringify({ id: "chat_probe", object: "chat.completion.chunk", model: "big-pickle", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
  { headers: { "content-type": "text/event-stream" } });
}

function responsesResponse(tool: boolean) {
  const item = tool
    ? { id: "fc_shell", type: "function_call", call_id: "call_shell", name: "shell", arguments: '{"command":"printf probe"}', status: "completed" }
    : { id: "msg_probe", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "COMPLETE", annotations: [] }] };
  const response = { id: "resp_probe", object: "response", model: "big-pickle", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
  const events = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", arguments: tool ? "" : undefined, content: tool ? undefined : [] } },
    ...(tool ? [
      { type: "response.function_call_arguments.delta", item_id: "fc_shell", output_index: 0, delta: '{"command":' },
      { type: "response.function_call_arguments.delta", item_id: "fc_shell", output_index: 0, delta: '"printf probe"}' },
      { type: "response.function_call_arguments.done", item_id: "fc_shell", output_index: 0, arguments: '{"command":"printf probe"}' },
    ] : [
      { type: "response.content_part.added", item_id: "msg_probe", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", item_id: "msg_probe", output_index: 0, content_index: 0, delta: "COMPLETE" },
      { type: "response.output_text.done", item_id: "msg_probe", output_index: 0, content_index: 0, text: "COMPLETE" },
    ]),
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

async function consume(stream: AssistantMessageEventStream) {
  const calls = [];
  for await (const event of stream) {
    if (event.type === "toolcall_end") calls.push(event.toolCall);
  }
  return { calls, message: await stream.result() };
}

test.each([CHAT_API, RESPONSES_API] as const)("%s preserves a real tool call, history, and conversation identity", async (api) => {
  const directory = mkdtempSync(join(tmpdir(), "omp-zen-transport-"));
  const requests: Array<{ path: string; headers: Headers; body: typeof CapturedPayload.infer }> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests.push({ path: new URL(request.url).pathname, headers: request.headers, body: CapturedPayload.assert(await request.json()) });
    return api === CHAT_API ? chatResponse(requests.length === 1) : responsesResponse(requests.length === 1);
  } });
  try {
    const model = fixtureModel(api);
    const run = createTransport(new OpenCodeClient("opencode/latest/2.2.5/cli"));
    const context: Context = { systemPrompt: ["You are a coding assistant."], messages: [{ role: "user", content: "Run printf probe.", timestamp: 0 }], tools: [bash] };
    const options = {
      cwd: directory, sessionId, reasoning: Effort.High, maxHttpAttempts: 1,
      // Keep the model's actual endpoint: loopback compat must not mask replay bugs.
      fetch: (input: string | URL | Request, init?: RequestInit) => fetch(new URL(new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url).pathname, server.url), init),
    };
    const first = await consume(run(model, context, options));
    expect(first.calls).toMatchObject([{ name: "bash", arguments: { command: "printf probe" } }]);
    expect(first.message.api).toBe(api);
    expect(first.message.content.find((part) => part.type === "toolCall")).toMatchObject({ name: "bash", arguments: { command: "printf probe" } });
    const second = await consume(run(model, { ...context, messages: [
      ...context.messages, first.message,
      { role: "toolResult", toolCallId: first.calls[0].id, toolName: "bash", content: [{ type: "text", text: "probe" }], isError: false, timestamp: 1 },
    ] }, options));
    expect(second.message.content).toMatchObject([{ type: "text", text: "COMPLETE" }]);
    expect(requests.map((request) => request.path)).toEqual(api === CHAT_API ? ["/inference/openai/v1/chat/completions", "/inference/openai/v1/chat/completions"] : ["/inference/openai/v1/responses", "/inference/openai/v1/responses"]);
    const declared = requests[0].body.tools!.map((tool) => tool.function?.name ?? tool.name);
    expect(declared).toEqual(["shell"]); // No unavailable tools have been fabricated.
    expect(context.tools?.[0].name).toBe("bash");
    expect(context.systemPrompt).toEqual(["You are a coding assistant."]);
    expect(requests[0].headers.get("x-opencode-session")).toBe(requests[1].headers.get("x-opencode-session"));
    expect(requests[0].headers.get("authorization")).toBe("Bearer public");
    const system = api === CHAT_API ? requests[0].body.messages!.filter((message) => message.role === "system" || message.role === "developer")
      : requests[0].body.instructions ?? requests[0].body.input!.filter((item) => item.role === "system" || item.role === "developer");
    expect(JSON.stringify(system)).toContain("Working directory:");
    if (api === CHAT_API) {
      const replay = requests[1].body.messages!.find((message) => message.role === "assistant");
      expect(replay).toMatchObject({ reasoning_content: trace, tool_calls: [{ function: { name: "shell" } }] });
      expect(requests[1].body.messages!.at(-1)).toMatchObject({ role: "tool", content: "probe" });
    } else {
      expect(requests[1].body.input!.find((item) => item.type === "function_call")).toMatchObject({ name: "shell", call_id: "call_shell" });
      expect(requests[1].body.input!.find((item) => item.type === "function_call_output")).toMatchObject({ call_id: "call_shell", output: "probe" });
    }
  } finally {
    server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
