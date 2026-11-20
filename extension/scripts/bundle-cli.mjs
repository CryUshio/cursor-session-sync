import { cpSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "cli");
const dest = join(here, "..", "vendor", "cursaves");
const skip = new Set([".git", ".venv", "__pycache__", ".github", "node_modules"]);

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, {
  recursive: true,
  filter: (source) => !skip.has(basename(source)) && !source.endsWith(".pyc"),
});
