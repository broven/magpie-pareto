// Playwright is not a runtime dependency of the plugin: the UI shot and
// frame check are development tools. Resolve it from the project if it is
// installed, else from Bun's install cache (where `bun add -d playwright`
// leaves it), so `bun install` for the plugin stays dependency-free.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function versionOf(name: string): number[] {
  const match = /^playwright@(\d+)\.(\d+)\.(\d+)/.exec(name);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
}

function compareVersion(a: string, b: string): number {
  const left = versionOf(a), right = versionOf(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return right[i] - left[i];
  return 0;
}

export async function loadChromium(): Promise<any> {
  try {
    const module = await import("playwright");
    if (module?.chromium) return module.chromium;
  } catch { /* not installed in the project */ }
  const cache = join(homedir(), ".bun/install/cache");
  try {
    const entries = readdirSync(cache)
      .filter(name => /^playwright@\d+\.\d+\.\d+/.test(name))
      .sort(compareVersion);
    for (const entry of entries) {
      const path = join(cache, entry, "index.js");
      if (!existsSync(path)) continue;
      try {
        const module = await import(path);
        if (module?.chromium) return module.chromium;
      } catch { /* try the next cached version */ }
    }
  } catch { /* no cache directory */ }
  throw new Error("需要 Playwright：bun add -d playwright（或安装 Chromium 后重试）");
}
