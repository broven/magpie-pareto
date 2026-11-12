import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePaths, type Paths } from "./config";
import { fetchBytes, fetchText, isStale, nowIso, readJson, readText, atomicWriteJson } from "./util";
import { unzipEntries } from "./zip";
import { normalizeModelId, stripProvider } from "./normalize";

export interface Price {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export interface GatewayModel {
  provider: string;
  model: string;
  id: string;
  pricing: Price | null;
  freeMarked: boolean;
  reasoningLevels: string[];
}

export interface CatalogModel {
  provider: string;
  id: string;
  family: string;
  releaseDate: string;
  cost: Price | null;
}

export interface CatalogData {
  fetchedAt: string;
  models: CatalogModel[];
}

export interface RapBoard {
  id: string;
  name: string;
  metric: string;
  snapshot: string;
}

export interface RapConfig {
  board: string;
  model: string;
  effort: string | null;
  harness: string;
  score: number;
}

export interface RapPlanPoint {
  planId: string;
  plan: string;
  model: string;
  priceUsd: number;
  monthlyTokens: number;
  listBlended: number;
  confidence: string;
  currency: string;
  unmetered: boolean;
}

export interface RapData {
  fetchedAt: string;
  boards: RapBoard[];
  configs: RapConfig[];
  plans: RapPlanPoint[];
}

export interface EpochRow {
  model: string;
  effort: string | null;
  score: number;
  date: string;
}

export interface EpochData {
  fetchedAt: string;
  snapshot: string;
  eci: EpochRow[];
  swe: EpochRow[];
}

export interface GroupInfo {
  id: string;
  name: string;
  members: string[];
  hidden: boolean;
}

export interface DataBundle {
  catalog: CatalogData;
  rap: RapData;
  epoch: EpochData;
  gateway: GatewayModel[];
  gatewayFetchedAt: string;
  cacheDates: Record<string, string>;
  warnings: string[];
}

const CACHE_FILES = {
  catalog: "models.json",
  rap: "rap.json",
  epoch: "epoch.json",
  gateway: "gateway.json",
} as const;

interface Cached<T> {
  fetchedAt: string;
  data: T;
}

function num(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function parsePrice(raw: any): Price | null {
  if (!raw || typeof raw !== "object") return null;
  const input = num(raw.prompt) ?? num(raw.input);
  const output = num(raw.completion) ?? num(raw.output);
  if (input === undefined && output === undefined) return null;
  const inputMt = (input ?? 0) * 1e6;
  const outputMt = (output ?? 0) * 1e6;
  const cacheRead = num(raw.input_cache_read) ?? num(raw.cache_read) ?? num(raw.cache?.read);
  const cacheWrite = num(raw.input_cache_write) ?? num(raw.cache_write) ?? num(raw.cache?.write);
  return {
    input: inputMt,
    output: outputMt,
    cache_read: cacheRead === undefined ? inputMt : cacheRead * 1e6,
    cache_write: cacheWrite === undefined ? inputMt : cacheWrite * 1e6,
  };
}

function parseOfficialCost(raw: any): Price | null {
  if (!raw || typeof raw !== "object") return null;
  const input = num(raw.input);
  const output = num(raw.output);
  if (input === undefined && output === undefined) return null;
  const inputMt = input ?? 0;
  const cacheRead = num(raw.cache_read) ?? num(raw.cache?.read);
  const cacheWrite = num(raw.cache_write) ?? num(raw.cache?.write);
  return {
    input: inputMt,
    output: output ?? 0,
    cache_read: cacheRead === undefined ? inputMt : cacheRead,
    cache_write: cacheWrite === undefined ? inputMt : cacheWrite,
  };
}

export function priceIsFree(price: Price | null): boolean {
  return !!price && price.input === 0 && price.output === 0 && price.cache_read === 0 && price.cache_write === 0;
}

function readPluginFree(path: string): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  // The file is small and read during a chart request; a sync read keeps the
  // loader simple, and a missing or broken cache simply marks nothing free.
  try {
    const text = readFileSync(path, "utf8");
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return map;
    for (const provider of parsed) {
      if (!provider || typeof provider !== "object") continue;
      const id = String(provider.id ?? "");
      if (!id || !Array.isArray(provider.models)) continue;
      const free = new Set<string>();
      for (const model of provider.models) {
        if (model && typeof model === "object" && model.free === true && model.id) free.add(String(model.id));
      }
      if (free.size) map.set(id, free);
    }
  } catch { /* no cache: nothing marked */ }
  return map;
}

export function parseGatewayModels(raw: any, freeMarked: Map<string, Set<string>> = new Map()): GatewayModel[] {
  const data = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : [];
  const models: GatewayModel[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const id = String(entry.id ?? "");
    const slash = id.indexOf("/");
    if (slash <= 0) continue;
    const provider = id.slice(0, slash);
    if (provider === "group" || provider === "auto") continue;
    const model = id.slice(slash + 1);
    if (!model) continue;
    const pricing = parsePrice(entry.pricing);
    const levels = Array.isArray(entry.reasoning_levels)
      ? entry.reasoning_levels.map(String)
      : Array.isArray(entry.supported_reasoning_levels)
        ? entry.supported_reasoning_levels.map((level: any) => String(level?.effort ?? level)).filter(Boolean)
        : [];
    models.push({
      provider,
      model,
      id,
      pricing,
      freeMarked: freeMarked.get(provider)?.has(model) ?? false,
      reasoningLevels: levels,
    });
  }
  return models;
}

function parseCatalog(raw: any, fetchedAt: string): CatalogData {
  const models: CatalogModel[] = [];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [providerId, provider] of Object.entries<any>(raw)) {
      const entries = provider?.models;
      if (!entries || typeof entries !== "object") continue;
      for (const [modelId, model] of Object.entries<any>(entries)) {
        if (!model || typeof model !== "object") continue;
        models.push({
          provider: providerId,
          id: String(model.id ?? modelId),
          family: String(model.family ?? ""),
          releaseDate: String(model.release_date ?? ""),
          cost: parseOfficialCost(model.cost),
        });
      }
    }
  }
  return { fetchedAt, models };
}

function parseRap(raw: any, fetchedAt: string): RapData {
  const boards: RapBoard[] = [];
  if (raw?.boards && typeof raw.boards === "object") {
    for (const [id, board] of Object.entries<any>(raw.boards)) {
      boards.push({
        id,
        name: String(board?.name ?? id),
        metric: String(board?.metric ?? ""),
        snapshot: String(board?.snapshot ?? ""),
      });
    }
  }
  const configs: RapConfig[] = [];
  for (const item of Array.isArray(raw?.configurations) ? raw.configurations : []) {
    const score = num(item?.score);
    if (score === undefined) continue;
    const effortRaw = item?.reasoning_effort;
    const effort = effortRaw == null || /^(none|null)$/i.test(String(effortRaw)) ? null : String(effortRaw).toLowerCase();
    configs.push({
      board: String(item?.board ?? ""),
      model: String(item?.model ?? ""),
      effort,
      harness: String(item?.agent_harness ?? item?.variant ?? ""),
      score,
    });
  }
  const plans: RapPlanPoint[] = [];
  for (const item of Array.isArray(raw?.points) ? raw.points : []) {
    const priceUsd = num(item?.price_usd);
    const monthlyTokens = num(item?.monthly_tokens);
    const listBlended = num(item?.list_blended_usd_per_mtok);
    if (priceUsd === undefined || monthlyTokens === undefined || listBlended === undefined) continue;
    plans.push({
      planId: String(item?.plan_id ?? ""),
      plan: String(item?.plan ?? item?.plan_id ?? ""),
      model: String(item?.model ?? ""),
      priceUsd,
      monthlyTokens,
      listBlended,
      confidence: String(item?.confidence ?? ""),
      currency: String(item?.currency ?? "USD"),
      unmetered: item?.unmetered === true,
    });
  }
  return { fetchedAt, boards, configs, plans };
}

function csvRows(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let field = "", row: string[] = [], quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map(name => name.trim());
  const out: Array<Record<string, string>> = [];
  for (const line of rows.slice(1)) {
    if (!line.length || line.every(value => value === "")) continue;
    const record: Record<string, string> = {};
    header.forEach((name, index) => { record[name] = line[index] ?? ""; });
    out.push(record);
  }
  return out;
}

const EFFORT_SUFFIXES = ["minimal", "low", "medium", "high", "xhigh", "max", "none", "unknown", "thinking"];

function parseEpoch(buffer: Buffer, fetchedAt: string): EpochData {
  const entries = unzipEntries(buffer);
  const eciText = entries.get("epoch_capabilities_index/eci_scores.csv")?.toString("utf8") ?? "";
  const sweText = entries.get("swe_bench_verified.csv")?.toString("utf8") ?? "";
  const eci: EpochRow[] = [];
  for (const row of csvRows(eciText)) {
    const score = num(row["eci"]);
    const model = row["Model"] ?? row["Display name"] ?? "";
    if (score === undefined || !model) continue;
    eci.push({ model, effort: null, score, date: row["date"] ?? "" });
  }
  const swe: EpochRow[] = [];
  for (const row of csvRows(sweText)) {
    const version = row["Model version"] ?? "";
    const score = num(row["mean_score"]) ?? num(row["Best score (across scorers)"]);
    if (!version || score === undefined) continue;
    let model = version;
    let effort: string | null = null;
    const cut = version.lastIndexOf("_");
    if (cut > 0) {
      const suffix = version.slice(cut + 1).toLowerCase();
      if (EFFORT_SUFFIXES.includes(suffix)) {
        model = version.slice(0, cut);
        effort = suffix === "unknown" || suffix === "none" ? null : suffix;
      }
    }
    swe.push({
      model,
      effort,
      score: score <= 1 ? score * 100 : score,
      date: row["Release date"] ?? "",
    });
  }
  const dates = [...eci.map(row => row.date), ...swe.map(row => row.date)].filter(Boolean).sort();
  const snapshot = dates.length ? dates[dates.length - 1] : fetchedAt.slice(0, 10);
  return { fetchedAt, snapshot, eci, swe };
}

async function readCache<T>(cacheDir: string, name: string): Promise<Cached<T> | null> {
  const raw = await readJson<Cached<T>>(join(cacheDir, name));
  if (!raw || typeof raw !== "object" || !raw.fetchedAt || raw.data === undefined) return null;
  return raw;
}

export class DataStore {
  paths: Paths;
  private refreshing: Promise<{ warnings: string[] }> | null = null;

  constructor(paths: Paths = resolvePaths()) {
    this.paths = paths;
  }

  private async refreshCatalog(): Promise<CatalogData> {
    const text = await fetchText(this.paths.modelsJson);
    const raw = JSON.parse(text);
    return parseCatalog(raw, nowIso());
  }

  private async refreshRap(): Promise<RapData> {
    const text = await fetchText(this.paths.rapUrl);
    return parseRap(JSON.parse(text), nowIso());
  }

  private async refreshEpoch(): Promise<EpochData> {
    const buffer = await fetchBytes(this.paths.epochUrl);
    return parseEpoch(buffer, nowIso());
  }

  private async fetchGateway(): Promise<{ models: GatewayModel[]; fetchedAt: string }> {
    const response = await fetch(`${this.paths.gateway}/v1/models`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`GET /v1/models: HTTP ${response.status}`);
    const raw = await response.json();
    const free = readPluginFree(this.paths.pluginProvidersFile);
    return { models: parseGatewayModels(raw, free), fetchedAt: nowIso() };
  }

  async refreshAll(): Promise<{ warnings: string[] }> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const warnings: string[] = [];
      const jobs: Array<[string, () => Promise<unknown>]> = [
        ["models", async () => {
          const data = await this.refreshCatalog();
          await atomicWriteJson(join(this.paths.cacheDir, CACHE_FILES.catalog), { fetchedAt: data.fetchedAt, data });
        }],
        ["rap", async () => {
          const data = await this.refreshRap();
          await atomicWriteJson(join(this.paths.cacheDir, CACHE_FILES.rap), { fetchedAt: data.fetchedAt, data });
        }],
        ["epoch", async () => {
          const data = await this.refreshEpoch();
          await atomicWriteJson(join(this.paths.cacheDir, CACHE_FILES.epoch), { fetchedAt: data.fetchedAt, data });
        }],
        ["gateway", async () => {
          const data = await this.fetchGateway();
          await atomicWriteJson(join(this.paths.cacheDir, CACHE_FILES.gateway), { fetchedAt: data.fetchedAt, data });
        }],
      ];
      const results = await Promise.allSettled(jobs.map(async ([name, job]) => {
        try { await job(); } catch (error: any) { warnings.push(`${name}: ${error?.message ?? error}`); }
      }));
      void results;
      return { warnings };
    })();
    try { return await this.refreshing; } finally { this.refreshing = null; }
  }

  async ensure(): Promise<DataBundle> {
    const warnings: string[] = [];
    const catalogCache = await readCache<CatalogData>(this.paths.cacheDir, CACHE_FILES.catalog);
    const rapCache = await readCache<RapData>(this.paths.cacheDir, CACHE_FILES.rap);
    const epochCache = await readCache<EpochData>(this.paths.cacheDir, CACHE_FILES.epoch);
    const cachedGateway = await readCache<{ models: GatewayModel[] }>(this.paths.cacheDir, CACHE_FILES.gateway);
    if (!catalogCache || !rapCache || !epochCache) {
      const refreshed = await this.refreshAll();
      warnings.push(...refreshed.warnings);
    } else if (isStale(catalogCache.fetchedAt) || isStale(rapCache.fetchedAt) || isStale(epochCache.fetchedAt)) {
      // Stale data stays on screen; the refresh happens in the background.
      void this.refreshAll().catch(() => {});
    }
    const catalog = (await readCache<CatalogData>(this.paths.cacheDir, CACHE_FILES.catalog))?.data ?? catalogCache?.data;
    const rap = (await readCache<RapData>(this.paths.cacheDir, CACHE_FILES.rap))?.data ?? rapCache?.data;
    const epoch = (await readCache<EpochData>(this.paths.cacheDir, CACHE_FILES.epoch))?.data ?? epochCache?.data;
    if (!catalog || !rap || !epoch) throw new Error(`数据缓存不完整：${warnings.join("；") || "未知错误"}`);
    let gateway = cachedGateway?.data?.models ?? [];
    let gatewayFetchedAt = cachedGateway?.fetchedAt ?? "";
    try {
      const fresh = await this.fetchGateway();
      gateway = fresh.models;
      gatewayFetchedAt = fresh.fetchedAt;
      await atomicWriteJson(join(this.paths.cacheDir, CACHE_FILES.gateway), { fetchedAt: fresh.fetchedAt, data: { models: fresh.models } });
    } catch (error: any) {
      if (!gateway.length) warnings.push(`gateway: ${error?.message ?? error}`);
      else warnings.push(`gateway: 使用缓存（${error?.message ?? error}）`);
    }
    return {
      catalog,
      rap,
      epoch,
      gateway,
      gatewayFetchedAt,
      cacheDates: {
        models: catalog.fetchedAt,
        rap: rap.fetchedAt,
        epoch: epoch.fetchedAt,
        gateway: gatewayFetchedAt,
      },
      warnings,
    };
  }
}

export function readGroups(paths: Paths): GroupInfo[] {
  try {
    const text = readFileSync(paths.providersFile, "utf8");
    const raw = JSON.parse(text);
    const groups = Array.isArray(raw?.groups) ? raw.groups : [];
    return groups
      .filter((group: any) => group && typeof group === "object")
      .map((group: any) => ({
        id: String(group.id ?? ""),
        name: String(group.name ?? group.id ?? ""),
        members: Array.isArray(group.members) ? group.members.map(String) : [],
        hidden: group.hidden === true,
      }))
      .filter(group => group.id);
  } catch {
    return [];
  }
}

export function readProviderNames(paths: Paths): Map<string, string> {
  const names = new Map<string, string>();
  try {
    const raw = JSON.parse(readFileSync(paths.providersFile, "utf8"));
    for (const provider of Array.isArray(raw?.providers) ? raw.providers : []) {
      if (!provider || typeof provider !== "object") continue;
      const id = String(provider.id ?? "");
      if (id) names.set(id, String(provider.name ?? id));
    }
  } catch { /* no provider names: fall back to ids */ }
  return names;
}

export function readPluginProviders(path: Paths): Map<string, Set<string>> {
  return readPluginFree(path.pluginProvidersFile);
}

export async function readUsageLines(paths: Paths): Promise<any[]> {
  const text = await readText(paths.usageFile);
  if (!text) return [];
  const out: any[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (row && typeof row === "object") out.push(row);
    } catch { /* a torn final line is normal while magpie writes */ }
  }
  return out;
}

export function modelKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

export function officialFor(catalog: CatalogData, rawModel: string): CatalogModel | null {
  const normalized = normalizeModelId(rawModel);
  const knownVendors = ["deepseek", "zhipuai", "moonshotai", "openai", "anthropic", "alibaba", "xiaomi", "minimax", "google", "xai"];
  // A free channel entry normalizes to the same id (deepseek-v4.1-flash-free
  // drops the -free marker); its all-zero cost is not an official price.
  const candidates = catalog.models.filter(model => normalizeModelId(model.id) === normalized && model.cost && !priceIsFree(model.cost));
  if (!candidates.length) return null;
  for (const vendor of knownVendors) {
    const hit = candidates.find(model => model.provider === vendor);
    if (hit) return hit;
  }
  return candidates[0];
}

export function catalogModelsFor(catalog: CatalogData, rawModel: string): CatalogModel[] {
  const normalized = normalizeModelId(rawModel);
  return catalog.models.filter(model => normalizeModelId(model.id) === normalized);
}

export function stripModelId(id: string): string {
  return stripProvider(id);
}
