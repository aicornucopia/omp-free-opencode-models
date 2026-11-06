import { expect, test } from "bun:test";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { convertMessages } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { BASE_URL, freeModels } from "./catalog.ts";

function bigPickle() {
  const [definition] = freeModels({ data: [{
    id: "big-pickle",
    name: "Big Pickle",
    type: "chat",
    modalities: { input: ["text"], output: ["text"] },
    capabilities: { reasoning: { supported: true } },
    limit: { context: 200_000, output: 32_000 },
    cost: { text: { input: { price: 0 }, output: { price: 0 } } },
    api: { "chat-completions": {
      base_url: BASE_URL,
      compatibility: { reasoning_field: "reasoning_content" },
    } },
  }] });
  // Use the real endpoint: a loopback URL enables replay automatically and masks this bug.
  return buildModel({ ...definition, api: "openai-completions", provider: "opencode-free", baseUrl: BASE_URL });
}

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "opencode-free",
    model: "big-pickle",
    content,
    stopReason,
    timestamp: 1,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

const toolCall = { type: "toolCall", id: "call_echo", name: "echo", arguments: { value: "ping" } } as const;

test("Big Pickle replays exact nonempty reasoning through a tool result", () => {
  const model = bigPickle();
  const earlierReasoning = " Consider the first question.\nKeep this whitespace. ";
  const toolReasoning = " Need the tool's result.\nCall echo with ping. ";
  const context: Context = { messages: [
    { role: "user", content: "Say ready.", timestamp: 0 },
    assistant([
      { type: "thinking", thinking: earlierReasoning, thinkingSignature: "reasoning_content" },
      { type: "text", text: "Ready." },
    ], "stop"),
    { role: "user", content: "Echo ping.", timestamp: 2 },
    assistant([
      { type: "thinking", thinking: toolReasoning, thinkingSignature: "reasoning_content" },
      toolCall,
    ], "toolUse"),
    { role: "toolResult", toolCallId: "call_echo", toolName: "echo", content: [{ type: "text", text: "ping" }], isError: false, timestamp: 3 },
  ] };

  const wire = convertMessages(model, context, model.compat);
  expect(wire[1]).toMatchObject({ role: "assistant", content: "Ready.", reasoning_content: earlierReasoning });
  expect(wire[3]).toMatchObject({
    role: "assistant",
    reasoning_content: toolReasoning,
    tool_calls: [{ id: "call_echo", type: "function", function: { name: "echo", arguments: '{"value":"ping"}' } }],
  });
  expect(wire[4]).toMatchObject({ role: "tool", tool_call_id: "call_echo", content: "ping" });
});

test("Big Pickle does not invent synthetic reasoning when none was captured", () => {
  const model = bigPickle();
  const wire = convertMessages(model, { messages: [
    { role: "user", content: "Echo ping.", timestamp: 0 },
    assistant([toolCall], "toolUse"),
    { role: "toolResult", toolCallId: "call_echo", toolName: "echo", content: [{ type: "text", text: "ping" }], isError: false, timestamp: 2 },
    assistant([{ type: "text", text: "ping" }], "stop"),
    { role: "user", content: "Continue.", timestamp: 3 },
  ] }, model.compat);
  expect(wire[1]).toHaveProperty("reasoning_content", "");
  expect(wire[3]).toHaveProperty("reasoning_content", "");
});
