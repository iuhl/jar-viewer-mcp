#!/usr/bin/env node
import { cp, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const sourceJar = path.join(projectRoot, "lib", "cfr-0.152.jar");
const targetDir = path.join(projectRoot, "dist", "lib");
const targetJar = path.join(targetDir, path.basename(sourceJar));

async function main() {
  try {
    await stat(sourceJar);
  } catch {
    throw new Error(`Missing CFR jar at ${sourceJar}. Download it before building.`);
  }

  await mkdir(targetDir, { recursive: true });
  await cp(sourceJar, targetJar);
  console.log(`Copied ${sourceJar} -> ${targetJar}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
