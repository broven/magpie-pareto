import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Paths {
  root: string;
  configDir: string;
  stateDir: string;
  cacheDir: string;
  stateFile: string;
  providersFile: string;
  usageFile: string;
  pluginProvidersFile: string;
  modelsJson: string;
  rapUrl: string;
  epochUrl: string;
  aliasesFile: string;
  gateway: string;
}

export const root = dirname(dirname(fileURLToPath(import.meta.url)));

function firstExisting(candidates: string[]): string {
  return candidates.find(path => existsSync(path)) ?? candidates[0];
}

export function gatewayBase(raw: string): string {
  const value = raw.trim();
  if (!value) return "http://127.0.0.1:3425";
  return /^https?:\/\//i.test(value) ? value.replace(/\/+$/, "") : `http://${value.replace(/\/+$/, "")}`;
}

export function resolvePaths(env: Record<string, string | undefined> = process.env): Paths {
  const configDir = env.PARETO_CONFIG_DIR || join(homedir(), ".config/magpie");
  const stateDir = env.PARETO_STATE_DIR || join(configDir, "pareto");
  return {
    root,
    configDir,
    stateDir,
    cacheDir: join(stateDir, "cache"),
    stateFile: join(stateDir, "state.json"),
    providersFile: join(configDir, "providers.json"),
    usageFile: join(configDir, "usage.jsonl"),
    pluginProvidersFile: join(configDir, "plugin-providers.json"),
    modelsJson: env.PARETO_MODELS_JSON || firstExisting([
      join(homedir(), ".cache/magpie/models.json"),
      join(homedir(), ".cache/opencode/models.json"),
    ]),
    rapUrl: env.PARETO_RAP_URL || "https://realapipricing.com/data/site.json",
    epochUrl: env.PARETO_EPOCH_URL || "https://epoch.ai/data/benchmark_data.zip",
    aliasesFile: env.PARETO_ALIASES || join(root, "data/aliases.json"),
    gateway: gatewayBase(env.MAGPIE_ADDR || "127.0.0.1:3425"),
  };
}

export function magpieEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const raw = env.PARETO_MAGPIE_ENV;
  if (!raw) return {};
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("PARETO_MAGPIE_ENV 不是 JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PARETO_MAGPIE_ENV 必须是 JSON 对象");
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") throw new Error(`PARETO_MAGPIE_ENV.${key} 必须是字符串`);
    out[key] = item;
  }
  return out;
}
