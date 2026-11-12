// Model backends. Claude Code and Codex run the CLI you're already signed into
// (your Claude or ChatGPT plan); Anthropic and OpenAI use an API key.

import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

export const PROVIDERS = ["claude-code", "codex", "anthropic", "openai"] as const;
export type Provider = (typeof PROVIDERS)[number];
export interface ChatTurn { role: "user" | "assistant"; content: string }
export interface Settings { provider: Provider; model: string; keys: { anthropic?: string; openai?: string } }
export interface Call { system: string; messages: ChatTurn[]; schemaName: string; schema: object }

type ModelErrorCategory = "auth" | "rate_limit" | "refusal" | "truncated" | "bad_json" | "upstream" | "not_installed";
export class ModelError extends Error {
  category: ModelErrorCategory;
  constructor(category: ModelErrorCategory, message: string) { super(message); this.category = category; }
}

export const DEFAULT_MODEL: Record<Provider, string> = { "claude-code": "sonnet", codex: "", anthropic: "claude-opus-5-5", openai: "" };
const TIMEOUT_MS = 5 * 60_000;

// ---------- finding the CLIs ----------

const EXTRA_PATHS: Record<"claude" | "codex", string[]> = {
  claude: [join(process.env.HOME ?? "", ".local/bin/claude"), join(process.env.HOME ?? "", ".claude/local/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"],
  // The ChatGPT desktop app ships Codex without putting it on PATH.
  codex: ["/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex", "/opt/homebrew/bin/codex", "/usr/local/bin/codex"],
};

export function findBin(name: "claude" | "codex"): string | null {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((d) => join(d, name));
  for (const p of [...dirs, ...EXTRA_PATHS[name]]) {
    try { accessSync(p, constants.X_OK); return p; } catch { /* keep looking */ }
  }
  return null;
}

export function detect(): Record<Provider, boolean> {
  return { "claude-code": !!findBin("claude"), codex: !!findBin("codex"), anthropic: true, openai: true };
}

/** Why this configuration can't run, or null if it can. */
export function unusable(s: Settings, available: Record<Provider, boolean> = detect()): string | null {
  if (s.provider === "claude-code" && !available["claude-code"]) return "Claude Code isn't installed.";
  if (s.provider === "codex" && !available.codex) return "Codex isn't installed.";
  if (s.provider === "anthropic" && !s.keys.anthropic) return "Add an Anthropic API key.";
  if (s.provider === "openai" && !s.keys.openai) return "Add an OpenAI API key.";
  if (s.provider === "openai" && !s.model) return "Enter an OpenAI model id.";
  return null;
}

// ---------- the call ----------

/** One structured-output call. Keys are used for this request only: never logged or attached to errors. */
export async function structuredCall(s: Settings, c: Call): Promise<unknown> {
  const why = unusable(s);
  if (why) throw new ModelError("not_installed", why);
  if (s.provider === "claude-code") return claudeCode(s.model, c);
  if (s.provider === "codex") return codex(s.model, c);
  return apiCall(s, c);
}

/** CLI backends take one prompt, so a multi-turn conversation becomes a transcript. */
function transcript(messages: ChatTurn[]) {
  if (messages.length === 1) return messages[0].content;
  return messages.map((m) => `${m.role === "user" ? "User" : "Assistant"}:\n${m.content}`).join("\n\n")
    + "\n\nRespond to the last User message.";
}

function run(bin: string, args: string[], input: string, cwd: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    // The CLI can exit before reading the whole prompt; that EPIPE would otherwise crash PagePatch.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** Runs in an empty temp folder so neither CLI picks up project files or instructions. */
async function inTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pagepatch-"));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

const signInHint = (text: string) => /log ?in|sign ?in|auth|credential|unauthori[sz]ed|401/i.test(text);

async function claudeCode(model: string, c: Call): Promise<unknown> {
  const args = [
    "-p", "--output-format", "json", "--json-schema", JSON.stringify(c.schema),
    "--system-prompt", c.system,
    "--tools", "",                     // no file, shell, or web access: it only writes JSON
    "--no-session-persistence", "--strict-mcp-config", "--disable-slash-commands", "--setting-sources", "",
    ...(model ? ["--model", model] : []),
  ];
  const r = await inTempDir((dir) => run(findBin("claude")!, args, transcript(c.messages), dir));
  let res: any;
  try { res = JSON.parse(r.out); } catch {
    const text = (r.err || r.out).trim().slice(0, 300);
    throw new ModelError(signInHint(text) ? "auth" : "upstream", signInHint(text) ? "Claude Code isn't signed in. Run `claude` once in a terminal to sign in." : `Claude Code failed${text ? `: ${text}` : "."}`);
  }
  if (res.is_error) {
    const text = String(res.result ?? res.api_error_status ?? "").slice(0, 300);
    if (signInHint(text)) throw new ModelError("auth", "Claude Code isn't signed in. Run `claude` once in a terminal to sign in.");
    if (/limit|rate/i.test(text)) throw new ModelError("rate_limit", `Claude Code hit a usage limit: ${text}`);
    throw new ModelError("upstream", `Claude Code returned an error: ${text}`);
  }
  if (res.structured_output === undefined) throw new ModelError("bad_json", "Claude Code didn't return structured output.");
  return res.structured_output;
}

const CODEX_TOOLS = ["shell_tool", "unified_exec", "apps", "browser_use", "browser_use_external", "in_app_browser", "computer_use"];

async function codex(model: string, c: Call): Promise<unknown> {
  return inTempDir(async (dir) => {
    await writeFile(join(dir, "schema.json"), JSON.stringify(c.schema));
    const args = [
      "exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "--color", "never",
      // No shell, browser, apps, or your own MCP servers: page and source text in the prompt is untrusted.
      "--ignore-user-config",
      ...CODEX_TOOLS.flatMap((f) => ["--disable", f]),
      "--output-schema", join(dir, "schema.json"), "-o", join(dir, "out.json"), "-C", dir,
      ...(model ? ["-m", model] : []), "-",
    ];
    // Codex has no system-prompt flag, so the instructions lead the prompt.
    const prompt = `${c.system}\n\nDo not run commands or read files. Reply only with the JSON response.\n\n${transcript(c.messages)}`;
    const r = await run(findBin("codex")!, args, prompt, dir);
    let text = "";
    try { text = await readFile(join(dir, "out.json"), "utf8"); } catch { /* no answer */ }
    if (!text.trim()) {
      const log = (r.err || r.out).trim().split("\n").slice(-3).join(" ").slice(0, 300);
      if (signInHint(log)) throw new ModelError("auth", "Codex isn't signed in. Open Codex or run `codex login` to sign in.");
      throw new ModelError("upstream", `Codex failed${log ? `: ${log}` : "."}`);
    }
    try { return JSON.parse(text); } catch { throw new ModelError("bad_json", "Codex returned malformed JSON."); }
  });
}

async function apiCall(s: Settings, c: Call): Promise<unknown> {
  const { system, messages, schemaName, schema } = c;
  const model = s.model || DEFAULT_MODEL[s.provider];
  let text: string;
  try {
    if (s.provider === "anthropic") {
      const client = new Anthropic({ apiKey: s.keys.anthropic, maxRetries: 1 });
      const res = await client.messages.create({
        model,
        max_tokens: 16000,
        system,
        messages,
        output_config: { format: { type: "json_schema", schema: schema as Record<string, unknown> } },
      } as Anthropic.MessageCreateParamsNonStreaming);
      if (res.stop_reason === "refusal") throw new ModelError("refusal", "The model declined this request.");
      if (res.stop_reason === "max_tokens") throw new ModelError("truncated", "The model response was cut off.");
      text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    } else {
      const client = new OpenAI({ apiKey: s.keys.openai, maxRetries: 1 });
      const res = await client.responses.create({
        model,
        instructions: system,
        input: messages,
        text: { format: { type: "json_schema", name: schemaName, schema: schema as Record<string, unknown>, strict: true } },
      });
      if (res.status === "incomplete") throw new ModelError("truncated", "The model response was cut off.");
      text = res.output_text;
    }
  } catch (e) {
    if (e instanceof ModelError) throw e;
    const status = (e as { status?: number }).status;
    if (status === 401 || status === 403) throw new ModelError("auth", "The provider rejected the API key.");
    if (status === 429) throw new ModelError("rate_limit", "The provider rate-limited this request.");
    throw new ModelError("upstream", `The provider returned an error${status ? ` (${status})` : ""}.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ModelError("bad_json", "The model returned malformed JSON.");
  }
}
