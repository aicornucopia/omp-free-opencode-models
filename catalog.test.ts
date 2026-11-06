import { describe, expect, test } from "bun:test";
import { BASE_URL, freeModels } from "./catalog.ts";

type WireModel = Parameters<typeof freeModels>[0]["data"][number];
function model(overrides: Partial<WireModel> = {}): WireModel {
  return {
    id: "example-free",
    name: "Example Free",
    type: "chat",
    modalities: { input: ["text"], output: ["text"] },
    capabilities: { reasoning: { supported: true } },
    limit: { context: 200_000, output: 32_000 },
    cost: { text: { input: { price: 0 }, output: { price: 0 } } },
    api: { "chat-completions": { base_url: BASE_URL } },
    ...overrides,
  };
}

describe("free model selection", () => {
  test("uses prices, not a free-looking model name", () => {
    const paid = model({ id: "paid-free", cost: { text: { input: { price: 1 }, output: { price: 0 } } } });
    const free = model({ id: "big-pickle" });
    expect(freeModels({ data: [paid, free] }).map((entry) => entry.id)).toEqual(["big-pickle"]);
  });

  test.each<WireModel["cost"]>([
    undefined,
    {},
    { text: { input: { price: 0 } } },
    { text: { output: { price: 0 } } },
    { text: { input: { price: 0 }, output: { price: 1 } } },
    { text: { input: { price: 0, cache: { read: 1 } }, output: { price: 0 } } },
    { text: { input: { price: 0, cache: { write: 1 } }, output: { price: 0 } } },
    { text: { input: { price: 0 }, output: { price: 0 } }, image: { input: { price: 1 } } },
    { text: { input: { price: 0 }, output: { price: 0 } }, image: { input: {} } },
  ])("excludes unknown or chargeable pricing: %j", (cost) => {
    expect(freeModels({ data: [model({ cost })] })).toEqual([]);
  });

  test("does not register unsupported routes or incomplete capabilities", () => {
    const entries = [
      model({ type: "image" }),
      model({ modalities: { input: ["audio/wav"], output: ["text"] } }),
      model({ modalities: { input: ["text"], output: ["image/png"] } }),
      model({ limit: { context: 200_000 } }),
      model({ api: { "chat-completions": { base_url: "https://elsewhere.example/v1" } } }),
      model({ api: { messages: { base_url: BASE_URL } } }),
    ];
    expect(freeModels({ data: entries })).toEqual([]);
  });
});

describe("catalog protocol conversion", () => {
  test("preserves context, output, vision, and reasoning metadata", () => {
    const [entry] = freeModels({ data: [model({
      modalities: { input: ["text", "image/png", "audio/wav"], output: ["text"] },
      api: { "chat-completions": { base_url: BASE_URL, compatibility: { reasoning_field: "reasoning" } } },
    })] });
    expect(entry).toMatchObject({
      api: "openai-completions",
      input: ["text", "image"],
      reasoning: true,
      contextWindow: 200_000,
      maxTokens: 32_000,
      compat: { reasoningContentField: "reasoning" },
    });
  });

  test("routes Responses-only models through the Responses API", () => {
    const [entry] = freeModels({ data: [model({ api: { responses: { base_url: BASE_URL } } })] });
    expect(entry.api).toBe("openai-responses");
    expect(entry.compat).toBeUndefined();
  });
});
