import { resolvePaths, type Paths } from "./config";
import {
  DataStore,
  officialFor,
  readGroups,
  readProviderNames,
  readUsageLines,
  type CatalogModel,
  type DataBundle,
  type GatewayModel,
  type GroupInfo,
  type Price,
} from "./datasources";
import { normalizeModelId, seriesKey } from "./normalize";
import { LABS, labById, labForModel, OTHER_LAB } from "./lab";
import { buildBoardIndex, boardList, makeLlmClient, matchModel, resolveEntry, scoreForEntry, type BoardIndex, type MatchOutcome } from "./matching";
import { readJson, round } from "./util";
import { blendPrice, listProfiles, providerAverage, resolveProfile, summarizeUsage, type ProfileInfo, type UsageSummary } from "./usage";
import { readState, writeState, keyOf, type AliasEntry, type ParetoState } from "./state";

export interface ChartParams {
  board?: string;
  profile?: string;
  scale?: string;
  group?: string;
  allOld?: boolean;
}

export interface ChartPoint {
  id: string;
  provider: string;
  model: string;
  modelKey: string;
  series: string;
  lab: string;
  effort: string;
  effortKey: string;
  price: Price & { blended: number };
  free: boolean;
  score: number;
  scoreSource: string;
  harness: string;
  matchedModel: string;
  match: { kind: "manual" | "fuzzy" | "llm"; confirmed: boolean } | null;
  suspect: boolean;
  suspectFactor: number;
  oldGen: boolean;
  groups: string[];
  manual: boolean;
  releaseDate: string;
  quotaMultiplier: number | null;
}

export interface NoScorePoint {
  provider: string;
  model: string;
  modelKey: string;
  series: string;
  lab: string;
  price: Price & { blended: number };
  free: boolean;
  oldGen: boolean;
  groups: string[];
  match: { kind: string; confirmed: boolean; model: string } | null;
  releaseDate: string;
  quotaMultiplier: number | null;
}

export interface ChartLink {
  kind: "horizontal";
  modelKey: string;
  model: string;
  effort?: string;
  provider?: string;
  points: Array<{ provider: string; model: string; effort: string; price: number; score: number }>;
}

export interface ChartData {
  board: { id: string; name: string; metric: string; snapshot: string; source: string } | null;
  scale: "log" | "linear";
  profile: { id: string; label: string; vector: { input: number; output: number; cache_read: number; cache_write: number } };
  groupFilter: string | null;
  points: ChartPoint[];
  noScore: NoScorePoint[];
  links: ChartLink[];
  labs: Array<{ id: string; name: string }>;
  providers: Array<{ id: string; name: string; modelCount: number; hidden: boolean }>;
  boardModels: string[];
  unmatched: Array<{ model: string; providers: string[] }>;
  hiddenModels: Array<{ model: string; providers: string[] }>;
  aliases: Array<{ model: string; boardModel: string }>;
  boards: Array<{ id: string; name: string; metric: string; snapshot: string; source: string }>;
  profiles: Array<{ id: string; label: string }>;
  groups: Array<{ id: string; name: string }>;
  cacheDates: Record<string, string>;
  warnings: string[];
  freeColumn: boolean;
}

interface ModelSummary {
  modelId: string;
  series: string;
  releaseDate: string;
  blended: number;
  oldGen: boolean;
  keep: boolean;
}

function groupMembership(groups: GroupInfo[]): Map<string, string[]> {
  // group id -> flattened member patterns (nested group refs resolved).
  const byId = new Map(groups.map(group => [group.id, group]));
  const out = new Map<string, string[]>();
  const resolve = (id: string, seen: Set<string>): string[] => {
    if (out.has(id)) return out.get(id)!;
    if (seen.has(id)) return [];
    seen.add(id);
    const group = byId.get(id);
    if (!group) return [];
    const members: string[] = [];
    for (const raw of group.members) {
      const member = String(raw);
      if (member.startsWith("group/")) members.push(...resolve(member.slice("group/".length), seen));
      else members.push(member);
    }
    out.set(id, members);
    return members;
  };
  for (const group of groups) resolve(group.id, new Set());
  return out;
}

function wildcard(pattern: string, value: string): boolean {
  if (!pattern.includes("*")) return pattern === value;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function memberMatches(member: string, provider: string, model: string): boolean {
  const ref = member.replace(/:(minimal|low|medium|high|xhigh|max|none)$/i, "");
  if (ref.startsWith("group/")) return false;
  const slash = ref.indexOf("/");
  if (slash < 0) return wildcard(ref, model);
  return wildcard(ref.slice(0, slash), provider) && wildcard(ref.slice(slash + 1), model);
}

function groupsFor(provider: string, model: string, membership: Map<string, string[]>): string[] {
  const ids: string[] = [];
  for (const [id, members] of membership) {
    if (members.some(member => memberMatches(member, provider, model))) ids.push(id);
  }
  return ids.sort();
}

function applySuspect(score: number, state: ParetoState, provider: string, model: string): { score: number; suspect: boolean; factor: number } {
  const entry = state.suspect[`${provider}/${model}`];
  if (!entry?.suspect) return { score, suspect: false, factor: 1 };
  const factor = Number.isFinite(entry.factor) && entry.factor! > 0 ? Number(entry.factor) : 1;
  return { score: score * factor, suspect: true, factor };
}

function oldGenFilter(
  summaries: ModelSummary[],
  allOld: boolean,
): void {
  const bySeries = new Map<string, ModelSummary[]>();
  for (const item of summaries) {
    const list = bySeries.get(item.series) ?? [];
    list.push(item);
    bySeries.set(item.series, list);
  }
  for (const list of bySeries.values()) {
    const dated = list.filter(item => item.releaseDate);
    if (!dated.length) {
      for (const item of list) { item.oldGen = false; item.keep = true; }
      continue;
    }
    const latestDate = dated.map(item => item.releaseDate).sort().at(-1)!;
    const latest = list.filter(item => item.releaseDate === latestDate);
    const latestMin = Math.min(...latest.map(item => item.blended));
    for (const item of list) {
      const old = !!item.releaseDate && item.releaseDate < latestDate;
      item.oldGen = old;
      item.keep = !old || allOld || item.blended < latestMin;
    }
  }
}

function pointId(provider: string, model: string): string {
  return `${provider}/${model}`;
}

function priceWithBlend(price: Price, vector: { input: number; output: number; cache_read: number; cache_write: number }): Price & { blended: number } {
  return {
    input: round(price.input, 9),
    output: round(price.output, 9),
    cache_read: round(price.cache_read, 9),
    cache_write: round(price.cache_write, 9),
    blended: blendPrice(price, vector),
  };
}

export async function computeChart(paths: Paths = resolvePaths(), store = new DataStore(paths), params: ChartParams = {}): Promise<ChartData> {
  const state = await readState(paths);
  const data: DataBundle = await store.ensure();
  const aliases = (await readJson<Record<string, AliasEntry>>(paths.aliasesFile)) ?? {};
  const groups = readGroups(paths);
  const usageRows = await readUsageLines(paths);
  const usage: UsageSummary = summarizeUsage(usageRows);
  const profile: ProfileInfo = resolveProfile(params.profile, usage);
  const boards = boardList(data.rap, data.epoch);
  const board = boards.find(item => item.id === params.board) ?? boards[0] ?? null;
  const index = board ? buildBoardIndex(board.id, data.rap, data.epoch) : null;
  const membership = groupMembership(groups.filter(group => !(group.hidden && group.members.length === 0)));
  const llmModel = state.llmModel.trim();
  const llm = makeLlmClient(paths.gateway, llmModel);
  let llmChanged = false;
  const warnings = [...data.warnings];
  if (llmModel && llm) {
    // A chart is a read path; the cache write below is the only mutation.
  }

  const points: ChartPoint[] = [];
  const noScore: NoScorePoint[] = [];
  const summaries = new Map<string, ModelSummary>();
  const hiddenProviders = new Set(state.hiddenProviders);
  const hiddenModels = new Set(state.hiddenModels);
  const providerNames = readProviderNames(paths);
  const unmatched = new Map<string, Set<string>>();
  const scale = params.scale === "linear" ? "linear" : "log";

  const consider = async (gateway: GatewayModel): Promise<void> => {
    if (!gateway.pricing) return;
    const vector = profile.vector;
    const price = priceWithBlend(gateway.pricing, vector);
    const free = gateway.pricing.input === 0 && gateway.pricing.output === 0
      && gateway.pricing.cache_read === 0 && gateway.pricing.cache_write === 0;
    const catalogModel = officialFor(data.catalog, gateway.model);
    const series = state.series[normalizeModelId(gateway.model)]
      ?? state.series[normalizeModelId(catalogModel?.id ?? gateway.model)]
      ?? seriesKey(gateway.model, catalogModel?.family);
    const releaseDate = catalogModel?.releaseDate ?? "";
    const groupIds = groupsFor(gateway.provider, gateway.model, membership);
    let match: MatchOutcome | null = null;
    if (index) {
      match = await matchModel(gateway.model, index, {
        state,
        aliases,
        llm,
        onLlmCache: () => { llmChanged = true; },
      });
    }
    if (index && !match && !hiddenModels.has(gateway.model)) {
      const providers = unmatched.get(gateway.model) ?? new Set<string>();
      providers.add(gateway.provider);
      unmatched.set(gateway.model, providers);
    }
    const modelId = normalizeModelId(match?.model ?? gateway.model);
    const lab = labForModel(modelId).id;
    const summaryKey = `${gateway.provider}/${gateway.model}`;
    const quotaMultiplier = state.quotaMultipliers[keyOf(gateway.provider, gateway.model)] ?? null;
    summaries.set(summaryKey, { modelId, series, releaseDate, blended: price.blended, oldGen: false, keep: true });
    const base = {
      provider: gateway.provider,
      model: gateway.model,
      modelKey: modelId,
      series,
      lab,
      price,
      free,
      oldGen: false,
      groups: groupIds,
      releaseDate,
      quotaMultiplier,
    };
    let made = false;
    if (index && match) {
      const entry = resolveEntry(index, match);
      if (entry) {
        const effortPoint = scoreForEntry(entry, gateway.reasoningLevels);
        if (effortPoint) {
          const adjusted = applySuspect(effortPoint.score, state, gateway.provider, gateway.model);
          points.push({
            ...base,
            id: pointId(gateway.provider, gateway.model),
            effort: effortPoint.effort,
            effortKey: effortPoint.effortKey,
            score: adjusted.score,
            scoreSource: index.name,
            harness: effortPoint.harness,
            matchedModel: match.model,
            match: { kind: match.kind, confirmed: match.confirmed },
            suspect: adjusted.suspect,
            suspectFactor: adjusted.factor,
            manual: false,
          });
          made = true;
        }
      }
    }
    if (!made) {
      const manual = state.manualScores[board?.id ?? ""]?.[summaryKey];
      if (manual !== undefined && Number.isFinite(manual)) {
        points.push({
          ...base,
          id: pointId(gateway.provider, gateway.model),
          effort: "默认",
          effortKey: "",
          score: manual,
          scoreSource: "手动",
          harness: "",
          matchedModel: match?.model ?? gateway.model,
          match: match ? { kind: match.kind, confirmed: match.confirmed } : null,
          suspect: false,
          suspectFactor: 1,
          manual: true,
        });
      } else {
        noScore.push({
          ...base,
          modelKey: modelId,
          match: match ? { kind: match.kind, confirmed: match.confirmed, model: match.model } : null,
        });
      }
    }
  };

  for (const gateway of data.gateway) await consider(gateway);

  oldGenFilter([...summaries.values()], !!params.allOld);
  const keepOf = (provider: string, model: string): boolean => summaries.get(`${provider}/${model}`)?.keep ?? true;
  const oldOf = (provider: string, model: string): boolean => summaries.get(`${provider}/${model}`)?.oldGen ?? false;

  let keptPoints = points.filter(point => !hiddenProviders.has(point.provider) && !hiddenModels.has(point.model) && keepOf(point.provider, point.model));
  let keptNoScore = noScore.filter(item => !hiddenProviders.has(item.provider) && !hiddenModels.has(item.model) && keepOf(item.provider, item.model));
  for (const point of keptPoints) point.oldGen = oldOf(point.provider, point.model);
  for (const item of keptNoScore) item.oldGen = oldOf(item.provider, item.model);

  if (params.group) {
    keptPoints = keptPoints.filter(point => point.groups.includes(params.group!));
    keptNoScore = keptNoScore.filter(item => item.groups.includes(params.group!));
  }

  const providerCounts = new Map<string, number>();
  for (const gateway of data.gateway) {
    if (!gateway.pricing) continue;
    providerCounts.set(gateway.provider, (providerCounts.get(gateway.provider) ?? 0) + 1);
  }
  const providers = [...providerCounts.entries()]
    .map(([id, modelCount]) => ({ id, name: providerNames.get(id) ?? id, modelCount, hidden: hiddenProviders.has(id) }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const boardModels = index
    ? [...new Set([...index.entries.values()].flat().map(entry => entry.canonical))].sort()
    : [];
  const unmatchedList = [...unmatched.entries()]
    .map(([model, list]) => ({ model, providers: [...list].sort() }))
    .sort((a, b) => a.model.localeCompare(b.model));
  const hiddenModelProviders = new Map<string, Set<string>>();
  for (const gateway of data.gateway) {
    if (!gateway.pricing) continue;
    const list = hiddenModelProviders.get(gateway.model) ?? new Set<string>();
    list.add(gateway.provider);
    hiddenModelProviders.set(gateway.model, list);
  }
  const hiddenModelsList = [...hiddenModels]
    .sort((a, b) => a.localeCompare(b))
    .map(model => ({ model, providers: [...(hiddenModelProviders.get(model) ?? [])].sort() }));
  const userAliases = Object.entries(state.aliases)
    .filter(([, entry]) => entry && typeof entry === "object" && entry.model)
    .map(([model, entry]) => ({ model, boardModel: entry.model }))
    .sort((a, b) => a.model.localeCompare(b.model));

  const horizontal = new Map<string, ChartPoint[]>();
  for (const point of keptPoints) {
    const h = horizontal.get(point.modelKey) ?? [];
    h.push(point);
    horizontal.set(point.modelKey, h);
  }
  const links: ChartLink[] = [];
  for (const list of horizontal.values()) {
    const linkProviders = new Set(list.map(point => point.provider));
    if (linkProviders.size < 2) continue;
    links.push({
      kind: "horizontal",
      modelKey: list[0].modelKey,
      model: list[0].model,
      points: list.map(point => ({ provider: point.provider, model: point.model, effort: point.effort, price: point.price.blended, score: point.score })),
    });
  }

  if (llmChanged) {
    try { await writeState(state, paths); } catch { /* cache write is best effort */ }
  }

  // Labs present in the response, in the fixed LABS order (其他 last). The UI
  // uses this list to name the legend groups.
  const labOrder = new Map([...LABS, OTHER_LAB].map((lab, index) => [lab.id, index]));
  const usedLabIds = new Set([...keptPoints.map(point => point.lab), ...keptNoScore.map(item => item.lab)]);
  const labs = [...usedLabIds]
    .map(id => labById(id))
    .sort((a, b) => (labOrder.get(a.id) ?? LABS.length + 1) - (labOrder.get(b.id) ?? LABS.length + 1) || a.id.localeCompare(b.id))
    .map(lab => ({ id: lab.id, name: lab.name }));

  return {
    board: board ? { ...board } : null,
    scale,
    profile: { id: profile.id, label: profile.label, vector: profile.vector },
    groupFilter: params.group ?? null,
    points: keptPoints,
    noScore: keptNoScore,
    links,
    labs,
    providers,
    boardModels,
    unmatched: unmatchedList,
    hiddenModels: hiddenModelsList,
    aliases: userAliases,
    boards,
    profiles: listProfiles(usage).map(item => ({ id: item.id, label: item.label })),
    groups: groups.filter(group => !(group.hidden && group.members.length === 0)).map(group => ({ id: group.id, name: group.name })),
    cacheDates: data.cacheDates,
    warnings,
    freeColumn: true,
  };
}

export function subscriptionContext(paths: Paths, data: DataBundle, usage: UsageSummary, profileId: string) {
  const profile = resolveProfile(profileId, usage);
  const byProvider = new Map<string, Array<{ model: string; current: Price & { blended: number }; official: CatalogModel | null }>>();
  for (const gateway of data.gateway) {
    if (!gateway.pricing) continue;
    const list = byProvider.get(gateway.provider) ?? [];
    list.push({
      model: gateway.model,
      current: priceWithBlend(gateway.pricing, profile.vector),
      official: officialFor(data.catalog, gateway.model),
    });
    byProvider.set(gateway.provider, list);
  }
  return { profile, byProvider, average: (provider: string) => providerAverage(usage, provider) };
}
