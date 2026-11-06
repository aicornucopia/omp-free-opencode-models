import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { environment, OpenCodeClient } from "./client.ts";

let directory: string;
beforeAll(() => { directory = realpathSync(mkdtempSync(join(tmpdir(), "omp-zen-client-"))); });
afterAll(() => { rmSync(directory, { recursive: true, force: true }); });
const session = "018f0000-0000-7000-8000-000000000001";
const userAgent = "opencode/latest/2.2.5/cli";

test("conversation identity survives new requests and resuming in a new client", () => {
  const client = new OpenCodeClient(userAgent);
  const workspace = client.workspace(directory);
  const first = client.headers(session, workspace);
  const second = client.headers(session, workspace);
  const resumed = new OpenCodeClient(userAgent).headers(session, workspace);
  const other = client.headers("018f0000-0000-7000-8000-000000000002", workspace);
  const id = first["x-opencode-session"];
  expect(id).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  for (const header of ["x-opencode-session", "x-opencode-session-id", "x-session-affinity", "x-session-id"]) {
    expect(first[header]).toBe(id);
    expect(second[header]).toBe(id);
    expect(resumed[header]).toBe(id);
  }
  expect(other["x-opencode-session"]).not.toBe(id);
  // OpenCode's descending ID encodes the actual OMP UUIDv7 creation time.
  const clock = (~BigInt(`0x${id.slice(4, 16)}`)) & 0xffffffffffffn;
  expect(clock).toBe(BigInt("0x018f00000000") * 0x1000n + 1n & 0xffffffffffffn);
});

test("trace formats agree on conversation and request attribution", () => {
  const client = new OpenCodeClient(userAgent);
  const workspace = client.workspace(directory);
  const first = client.headers(session, workspace);
  const second = client.headers(session, workspace);
  for (const headers of [first, second]) {
    const [trace, span, sampled, parent] = headers.b3.split("-");
    expect(trace).toMatch(/^[0-9a-f]{32}$/);
    expect(span).toMatch(/^[0-9a-f]{16}$/);
    expect(parent).toMatch(/^[0-9a-f]{16}$/);
    expect(sampled).toBe("1");
    expect(headers.traceparent).toBe(`00-${trace}-${span}-01`);
  }
  expect(first.traceparent.split("-")[1]).toBe(second.traceparent.split("-")[1]);
});

test("environment describes the real workspace rather than inventing OpenCode permissions", () => {
  const workspace = new OpenCodeClient(userAgent).workspace(directory);
  const block = environment(workspace);
  expect(block).toContain(`  Working directory: ${directory}`);
  expect(block).toContain(`  Workspace root folder: ${directory}`);
  expect(block).toContain("  Is directory a git repo: no");
  expect(block).not.toContain("approved for external access");
});
