// Build the extension into dist/ (and optionally a versioned ZIP in release/).
// Config comes from env so the published build points at the hosted API:
//   PAGEPATCH_API, GH_CLIENT_ID, GH_APP_SLUG
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const env = {
  PAGEPATCH_API: process.env.PAGEPATCH_API ?? "http://localhost:8787",
  GH_CLIENT_ID: process.env.GH_CLIENT_ID ?? "",
  GH_APP_SLUG: process.env.GH_APP_SLUG ?? "pagepatch",
};

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "icons"), { recursive: true });

await build({
  entryPoints: { background: "src/background.ts", content: "src/content.ts", sidepanel: "src/sidepanel.ts" },
  absWorkingDir: root,
  outdir: dist,
  bundle: true,
  format: "iife",
  target: "chrome116",
  minify: false, // readable bundles make Web Store review easier
  define: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, JSON.stringify(v)])),
});

for (const f of ["sidepanel.html", "sidepanel.css"]) cpSync(join(root, f), join(dist, f));
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
// E2E builds can't click the toolbar button, so they get localhost host access instead of activeTab. Never shipped.
if (process.env.PAGEPATCH_TEST === "1") manifest.host_permissions = ["http://127.0.0.1/*"];
writeFileSync(join(dist, "manifest.json"), JSON.stringify(manifest, null, 2));
for (const size of [16, 48, 128]) writeFileSync(join(dist, "icons", `${size}.png`), icon(size));

if (process.argv.includes("--zip")) {
  const { version } = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  const out = join(root, "..", "release");
  mkdirSync(out, { recursive: true });
  const zip = join(out, `pagepatch-extension-v${version}.zip`);
  rmSync(zip, { force: true });
  execFileSync("zip", ["-qr", zip, "."], { cwd: dist });
  console.log(`wrote ${zip}`);
}

// Icon: a page with a blue patch in the corner. Drawn per pixel so there's no image tooling dependency.
function icon(n) {
  const px = Buffer.alloc(n * n * 4);
  const r = n * 0.18;
  const inRounded = (x, y, x0, y0, x1, y1, rad) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.min(Math.max(x, x0 + rad), x1 - rad), cy = Math.min(Math.max(y, y0 + rad), y1 - rad);
    return (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad;
  };
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = (y * n + x) * 4, cx = x + 0.5, cy = y + 0.5;
    let c = null;
    if (inRounded(cx, cy, 0, 0, n, n, r)) c = [29, 29, 31];
    if (inRounded(cx, cy, n * 0.22, n * 0.16, n * 0.72, n * 0.84, n * 0.06)) c = [245, 245, 247];
    if (inRounded(cx, cy, n * 0.48, n * 0.48, n * 0.86, n * 0.86, n * 0.08)) c = [47, 111, 235];
    if (c) px.set([...c, 255], i);
  }
  const raw = Buffer.alloc(n * (n * 4 + 1));
  for (let y = 0; y < n; y++) px.copy(raw, y * (n * 4 + 1) + 1, y * n * 4, (y + 1) * n * 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}
