// Build dist/cli.js (Node), dist/overlay.js (loader injected into pages), and dist/panel.js (panel iframe).
import { build } from "esbuild";
import { chmodSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
rmSync(join(root, "dist"), { recursive: true, force: true });

for (const name of ["overlay", "panel"]) {
  await build({
    entryPoints: [`src/${name}.ts`], absWorkingDir: root, outfile: `dist/${name}.js`,
    bundle: true, format: "iife", target: "chrome116",
  });
}
await build({
  entryPoints: ["src/cli.ts"], absWorkingDir: root, outfile: "dist/cli.js",
  bundle: true, platform: "node", format: "esm", target: "node22",
  packages: "external", // runtime deps install with the package; @pagepatch/shared is bundled below
  plugins: [{ name: "bundle-shared", setup(b) { b.onResolve({ filter: /^@pagepatch\/shared$/ }, () => ({ path: join(root, "../shared/src/index.ts") })); } }],
  banner: { js: "#!/usr/bin/env node" },
});
chmodSync(join(root, "dist/cli.js"), 0o755);
