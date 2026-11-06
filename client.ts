import { createHash, randomBytes } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const VERSION_URL = "https://opencode.ai/update/api/latest/cli/npm";

type OmpSessionId = string & { readonly __ompSessionId: unique symbol };
type OpenCodeSessionId = string & { readonly __openCodeSessionId: unique symbol };
type ProjectId = string & { readonly __projectId: unique symbol };
type TraceId = string & { readonly __traceId: unique symbol };

const OmpSessionId = {
  parse(value: string): OmpSessionId {
    if (!value) throw new Error("OpenCode requires a nonempty OMP session ID");
    return value as OmpSessionId;
  },
};
const ProjectId = {
  fromGit(value: string): ProjectId {
    if (!/^[a-f0-9]{40,64}$/.test(value) && value !== "global") throw new Error("Invalid Git project ID");
    return value as ProjectId;
  },
  fromDirectory(directory: string): ProjectId {
    return createHash("sha1").update(`directory:${directory}`).digest("hex") as ProjectId;
  },
  fromRemote(remote: string): ProjectId | undefined {
    const url = URL.canParse(remote) ? new URL(remote) : undefined;
    const scp = /^([^@/:]+@)?([^/:]+):(.+)$/.exec(remote);
    const host = url?.hostname ?? scp?.[2];
    const path = (url?.pathname ?? scp?.[3])?.replace(/^\/+/, "").replace(/\.git\/?$/, "").replace(/\/+$/, "");
    if (!host || !path || url?.protocol === "file:") return undefined;
    return createHash("sha1").update(`git-remote:${host.toLowerCase()}/${path}`).digest("hex") as ProjectId;
  },
};

export interface Workspace {
  directory: string;
  root: string;
  git: boolean;
  project: ProjectId;
}

function git(directory: string, ...args: string[]): string | undefined {
  const result = spawnSync("git", args, { cwd: directory, encoding: "utf8", timeout: 2_000, windowsHide: true });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

export function workspace(directory: string): Workspace {
  directory = realpathSync(directory);
  const root = git(directory, "rev-parse", "--show-toplevel");
  if (!root) return { directory, root: directory, git: false, project: ProjectId.fromDirectory(directory) };
  const remote = git(directory, "config", "--get", "remote.origin.url");
  const remoteId = remote && ProjectId.fromRemote(remote);
  if (remoteId) return { directory, root, git: true, project: remoteId };
  const common = git(directory, "rev-parse", "--git-common-dir");
  let cached: string | undefined;
  if (common) {
    try { cached = readFileSync(resolve(directory, common, "opencode"), "utf8").trim(); } catch {}
  }
  const commit = cached || git(directory, "rev-list", "--max-parents=0", "HEAD")?.split("\n").sort()[0];
  return { directory, root, git: true, project: ProjectId.fromGit(commit || "global") };
}

export function environment(workspace: Workspace): string {
  return [
    "Here is some useful information about the environment you are running in:",
    "<env>",
    `  Working directory: ${workspace.directory}`,
    `  Workspace root folder: ${workspace.root}`,
    `  Is directory a git repo: ${workspace.git ? "yes" : "no"}`,
    `  Platform: ${process.platform}`,
    `  Temporary directory: ${tmpdir()}`,
    "</env>",
  ].join("\n");
}

class Session {
  private constructor(readonly id: OpenCodeSessionId, readonly trace: TraceId) {}

  static fromOmp(id: OmpSessionId): Session {
    // OMP mints UUIDv7s. Preserve their creation time and entropy when translating
    // to OpenCode's descending identifier, so resuming does not rotate identity.
    // OpenCode 2.2.5: packages/schema/src/identifier.ts (12 hex + 14 base62).
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id);
    const timestamp = uuid ? BigInt(`0x${id.replaceAll("-", "").slice(0, 12)}`) : BigInt(Date.now());
    const time = (~(timestamp * 0x1000n + 1n) & 0xffffffffffffn).toString(16).padStart(12, "0");
    const entropy = createHash("sha256").update(`opencode-session:${id}`).digest();
    const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let tail = "";
    for (let index = 0; index < 14; index++) tail += alphabet[entropy[index] % 62];
    const session = `ses_${time}${tail}` as OpenCodeSessionId;
    const trace = createHash("sha256").update(`opencode-trace:${id}`).digest("hex").slice(0, 32) as TraceId;
    return new Session(session, trace);
  }

  headers(project: ProjectId, userAgent: string): Record<string, string> {
    const span = randomBytes(8).toString("hex");
    return {
      Authorization: "Bearer public",
      "User-Agent": userAgent,
      "x-opencode-client": "cli",
      "x-opencode-project": project,
      "x-opencode-session": this.id,
      "x-opencode-session-id": this.id,
      "x-session-affinity": this.id,
      "x-session-id": this.id,
      b3: `${this.trace}-${span}-1-${randomBytes(8).toString("hex")}`,
      traceparent: `00-${this.trace}-${span}-01`,
      Accept: "*/*",
    };
  }
}

export class OpenCodeClient {
  private readonly sessions = new Map<OmpSessionId, Session>();
  private readonly workspaces = new Map<string, Workspace>();

  constructor(readonly userAgent: string) {}

  workspace(directory: string): Workspace {
    let result = this.workspaces.get(directory);
    if (!result) { result = workspace(directory); this.workspaces.set(directory, result); }
    return result;
  }

  headers(sessionId: string, workspace: Workspace): Record<string, string> {
    const id = OmpSessionId.parse(sessionId);
    let session = this.sessions.get(id);
    if (!session) { session = Session.fromOmp(id); this.sessions.set(id, session); }
    return session.headers(workspace.project, this.userAgent);
  }
}

export async function loadUserAgent(): Promise<string> {
  const response = await fetch(VERSION_URL, { signal: AbortSignal.timeout(3_000), redirect: "error" });
  if (!response.ok) throw new Error(`OpenCode release metadata: HTTP ${response.status}`);
  const release = await response.json();
  if (release?.channel !== "latest" || release?.name !== "cli" ||
    typeof release.version !== "string" || !/^\d+\.\d+\.\d+$/.test(release.version)) {
    throw new Error("OpenCode release metadata: expected the latest CLI release version");
  }
  return `opencode/${release.channel}/${release.version}/${release.name}`;
}
