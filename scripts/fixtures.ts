// Starts the fixture stack the E2E, UI shot and frame check share: a fake
// magpie gateway, a temp magpie config (providers/usage/plugin cache), a
// temp state dir, an Epoch zip built from the CSV fixtures, and the service.
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zipStored } from "../src/zip";

export const root = dirname(dirname(fileURLToPath(import.meta.url)));

export interface FixtureStack {
  base: string;
  token: string;
  gatewayPort: number;
  temp: string;
  configDir: string;
  stateDir: string;
  sandboxRoot: string;
  sandboxHome: string;
  epochZip: string;
  service: ReturnType<typeof Bun.spawn>;
  close: (keep?: boolean) => Promise<void>;
}

function rewriteUsage(text: string): string {
  const now = Date.now();
  return text.split("\n").filter(line => line.trim()).map((line, index) => {
    const row = JSON.parse(line);
    row.t = new Date(now - (index + 1) * 24 * 3600_000).toISOString();
    return JSON.stringify(row);
  }).join("\n") + "\n";
}

export async function startFixtureStack(options: { port?: number } = {}): Promise<FixtureStack> {
  const temp = await mkdtemp(join(tmpdir(), "pareto-fixtures-"));
  const configDir = join(temp, "config");
  const stateDir = join(temp, "state");
  const sandboxRoot = join(temp, "sandbox");
  const sandboxHome = join(sandboxRoot, "home");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await mkdir(join(sandboxRoot, "magpie"), { recursive: true, mode: 0o700 });
  await mkdir(sandboxHome, { recursive: true, mode: 0o700 });

  await cp(join(root, "fixtures/providers.json"), join(configDir, "providers.json"));
  await cp(join(root, "fixtures/plugin-providers.json"), join(configDir, "plugin-providers.json"));
  await cp(join(root, "fixtures/providers.json"), join(sandboxRoot, "magpie/providers.json"));
  await writeFile(join(configDir, "usage.jsonl"), rewriteUsage(await readFile(join(root, "fixtures/usage.jsonl"), "utf8")));

  const epochZip = join(temp, "epoch-fixture.zip");
  await writeFile(epochZip, zipStored({
    "epoch_capabilities_index/eci_scores.csv": await readFile(join(root, "fixtures/epoch/eci_scores.csv")),
    "swe_bench_verified.csv": await readFile(join(root, "fixtures/epoch/swe_bench_verified.csv")),
  }));

  const gatewayTemplate = JSON.parse(await readFile(join(root, "fixtures/gateway.json"), "utf8"));
  const gateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/v1/models") {
        const data = structuredClone(gatewayTemplate);
        let prices: Record<string, any> = {};
        try {
          const settings = JSON.parse(await readFile(join(sandboxRoot, "magpie/settings.json"), "utf8"));
          prices = settings.modelPrices ?? {};
        } catch { /* no settings yet */ }
        for (const entry of data.data) {
          const override = prices[entry.id];
          if (override) {
            entry.pricing = {
              prompt: String(Number(override.input) / 1e6),
              completion: String(Number(override.output) / 1e6),
              input_cache_read: String(Number(override.cache_read) / 1e6),
              input_cache_write: String(Number(override.cache_write) / 1e6),
            };
          }
        }
        return Response.json(data);
      }
      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        let body: any = {};
        try { body = await request.json(); } catch { /* empty */ }
        const text = JSON.stringify(body?.messages ?? []);
        const answer = text.includes("mystery-7") ? { model: "falcon-9", effort: null } : { model: null, effort: null };
        return Response.json({
          id: "fixture",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(answer) }, finish_reason: "stop" }],
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const gatewayPort = gateway.port ?? 0;

  const child = Bun.spawn([process.execPath, join(root, "src/server.ts")], {
    cwd: root,
    env: {
      ...process.env,
      MAGPIE_ADDR: `127.0.0.1:${gatewayPort}`,
      PARETO_PORT: String(options.port ?? 0),
      PARETO_CONFIG_DIR: configDir,
      PARETO_STATE_DIR: stateDir,
      PARETO_MODELS_JSON: join(root, "fixtures/models.json"),
      PARETO_RAP_URL: join(root, "fixtures/site.json"),
      PARETO_EPOCH_URL: epochZip,
      PARETO_ALIASES: join(root, "fixtures/aliases.json"),
      PARETO_MAGPIE_ENV: JSON.stringify({ XDG_CONFIG_HOME: sandboxRoot, HOME: sandboxHome }),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  let base = "";
  let stderr = "";
  const stderrReading = (async () => {
    const reader = child.stderr.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stderr += new TextDecoder().decode(value);
    }
  })();
  const stdoutReading = (async () => {
    const reader = child.stdout.getReader();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += new TextDecoder().decode(value);
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const hit = /^pareto listening (http:\/\/127\.0\.0\.1:\d+)$/.exec(line);
        if (hit) base = hit[1];
      }
    }
  })();

  const deadline = Date.now() + 15_000;
  while (!base && Date.now() < deadline && child.exitCode === null) await Bun.sleep(50);
  if (!base) {
    child.kill();
    await child.exited;
    throw new Error(`service did not start: ${stderr.trim()}`);
  }
  const page = await fetch(base + "/");
  const html = await page.text();
  const token = html.match(/name="pareto-token" content="([0-9a-f]{64})"/)?.[1] ?? "";
  if (!token) throw new Error("served HTML did not carry the API token");

  return {
    base,
    token,
    gatewayPort,
    temp,
    configDir,
    stateDir,
    sandboxRoot,
    sandboxHome,
    epochZip,
    service: child,
    close: async (keep = false) => {
      child.kill();
      await child.exited;
      await stdoutReading;
      await stderrReading;
      gateway.stop(true);
      if (!keep) await rm(temp, { recursive: true, force: true });
    },
  };
}
