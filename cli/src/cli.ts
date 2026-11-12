// pagepatch <dev-server-url> [--port 4400] [--root .] [--provider claude-code|codex|anthropic|openai] [--model id]
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { DEFAULT_MODEL, PROVIDERS, detect, structuredCall, unusable, type Provider, type Settings } from "./llm.ts";
import { createServers } from "./server.ts";

const USAGE = `Usage: pagepatch <dev-server-url> [options]

  pagepatch http://localhost:5173
  pagepatch 3000 --root ./web

Options:
  --port <n>         Port for PagePatch (default 4400; the panel uses the next port)
  --root <dir>       Project folder to edit (default: current folder)
  --provider <name>  claude-code, codex, anthropic, or openai (default: Claude Code, then Codex)
  --model <id>       Model for that provider (default: sonnet for Claude Code)

Claude Code and Codex use the login you already have. You can also switch
models, or add an API key, from Configure in the PagePatch panel.`;

function fail(msg: string): never {
  console.error(`${msg}\n\n${USAGE}`);
  process.exit(1);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string", default: "4400" },
    root: { type: "string", default: "." },
    provider: { type: "string" },
    model: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) { console.log(USAGE); process.exit(0); }

const raw = positionals[0] ?? fail("Tell PagePatch where your dev server is running.");
const target = /^\d+$/.test(raw) ? `http://localhost:${raw}` : raw;
try { if (!/^https?:$/.test(new URL(target).protocol)) throw 0; } catch { fail(`Not a valid http(s) URL: ${raw}`); }

const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65534) fail(`Invalid port: ${values.port}`);

const available = detect();
const keys = { anthropic: process.env.ANTHROPIC_API_KEY || undefined, openai: process.env.OPENAI_API_KEY || undefined };
const provider = (values.provider
  ?? (available["claude-code"] ? "claude-code" : available.codex ? "codex" : keys.anthropic ? "anthropic" : keys.openai ? "openai" : "claude-code")) as Provider;
if (!(PROVIDERS as readonly string[]).includes(provider)) fail(`Unknown provider: ${provider}`);
const settings: Settings = { provider, model: values.model ?? DEFAULT_MODEL[provider], keys };

const NAMES: Record<Provider, string> = { "claude-code": "Claude Code (your Claude login)", codex: "Codex (your ChatGPT login)", anthropic: "Anthropic API key", openai: "OpenAI API key" };
const root = resolve(values.root!);
const asset = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
const panelPort = port + 1;

const servers = createServers({
  target: new URL(target).origin,
  root,
  port,
  panelPort,
  token: randomBytes(24).toString("hex"),
  overlayJs: asset("overlay.js"),
  panelJs: asset("panel.js"),
  settings,
  available,
  model: structuredCall,
});

for (const [s, p] of [[servers.proxy, port], [servers.panel, panelPort]] as const) {
  s.on("error", (e: NodeJS.ErrnoException) => fail(e.code === "EADDRINUSE" ? `Port ${p} is in use. Try --port.` : e.message));
}
await new Promise<void>((r) => servers.panel.listen(panelPort, "127.0.0.1", r));
servers.proxy.listen(port, "127.0.0.1", () => {
  const problem = unusable(settings);
  console.log(`
  PagePatch is running

  Open      http://localhost:${port}
  Proxying  ${new URL(target).origin}
  Editing   ${root}
  Model     ${NAMES[settings.provider]}${settings.model ? ` / ${settings.model}` : ""}${problem ? `  (${problem} Change it under Configure.)` : ""}

  Selected page sections, your messages, and matching source files go to the model you pick.
  Nothing is written to disk until you approve a diff.
`);
});
