import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(rootDir, "web", "public");
const outputDir = join(rootDir, "public");

await mkdir(outputDir, { recursive: true });
await cp(sourceDir, outputDir, { recursive: true, force: true });
