import { normalizeModelId, stripProvider } from "./normalize";
import type { AliasEntry, ParetoState } from "./state";
import type { EpochData, RapData } from "./datasources";

export interface ScoreEntry {
  score: number;
  harness: string;
}

export interface BoardEntry {
  canonical: string;
  normalized: string;
  scores: Map<string, ScoreEntry>; // "" is the no-effort/default key
  hasEffort: boolean;
}

export interface BoardIndex {
  id: string;
  name: string;
  metric: string;
  snapshot: string;
  source: "rap" | "epoch";
  entries: Map<string, BoardEntry[]>;
  hasAnyEffort: boolean;
}

export interface MatchOutcome {
  model: string;
  effort: string | null;
  kind: "manual" | "fuzzy" | "llm";
  confirmed: boolean;
}

export interface LlmClient {
  model: string;
  ask: (rawModel: string, candidates: string[]) => Promise<string | null>;
}

export function alignEffort(effort: string | null | undefined): string | null {
  const value = String(effort ?? "").trim().toLowerCase();
  if (!value || value === "default" || value === "none" || value === "off" || value === "unknown") return null;
  if (value === "mid") return "medium";
  if (value === "thinking") return "high";
  return value;
}

function addScore(map: Map<string, ScoreEntry>, key: string, score: number, harness: string): void {
  const current = map.get(key);
  if (!current || score > current.score) map.set(key, { score, harness });
}

function rapIndex(boardId: string, rap: RapData): BoardIndex | null {
  const board = rap.boards.find(item => item.id === boardId);
  if (!board) return null;
  const entries = new Map<string, BoardEntry[]>();
  for (const config of rap.configs) {
    if (config.board !== boardId) continue;
    const normalized = normalizeModelId(config.model);
    if (!normalized) continue;
    let list = entries.get(normalized);
    if (!list) { list = []; entries.set(normalized, list); }
    let entry = list.find(item => item.canonical === config.model);
    if (!entry) {
      entry = { canonical: config.model, normalized, scores: new Map(), hasEffort: false };
      list.push(entry);
    }
    const key = alignEffort(config.effort) ?? "";
    if (key) entry.hasEffort = true;
    addScore(entry.scores, key, config.score, config.harness);
  }
  return {
    id: board.id,
    name: board.name,
    metric: board.metric,
    snapshot: board.snapshot,
    source: "rap",
    entries,
    hasAnyEffort: [...entries.values()].some(list => list.some(entry => entry.hasEffort)),
  };
}

function epochEciIndex(epoch: EpochData): BoardIndex {
  const entries = new Map<string, BoardEntry[]>();
  for (const row of epoch.eci) {
    const normalized = normalizeModelId(row.model);
    if (!normalized) continue;
    let list = entries.get(normalized);
    if (!list) { list = []; entries.set(normalized, list); }
    let entry = list.find(item => item.canonical === row.model);
    if (!entry) {
      entry = { canonical: row.model, normalized, scores: new Map(), hasEffort: false };
      list.push(entry);
    }
    addScore(entry.scores, "", row.score, "Epoch");
  }
  return {
    id: "epoch_eci",
    name: "Epoch ECI",
    metric: "ECI",
    snapshot: epoch.snapshot,
    source: "epoch",
    entries,
    hasAnyEffort: false,
  };
}

function epochSweIndex(epoch: EpochData): BoardIndex {
  const entries = new Map<string, BoardEntry[]>();
  for (const row of epoch.swe) {
    const normalized = normalizeModelId(row.model);
    if (!normalized) continue;
    let list = entries.get(normalized);
    if (!list) { list = []; entries.set(normalized, list); }
    let entry = list.find(item => item.canonical === row.model);
    if (!entry) {
      entry = { canonical: row.model, normalized, scores: new Map(), hasEffort: false };
      list.push(entry);
    }
    const key = alignEffort(row.effort) ?? "";
    if (key) entry.hasEffort = true;
    addScore(entry.scores, key, row.score, "Epoch");
  }
  return {
    id: "epoch_swe",
    name: "SWE-bench Verified (Epoch)",
    metric: "Pass@1 %",
    snapshot: epoch.snapshot,
    source: "epoch",
    entries,
    hasAnyEffort: [...entries.values()].some(list => list.some(entry => entry.hasEffort)),
  };
}

export function buildBoardIndex(boardId: string, rap: RapData, epoch: EpochData): BoardIndex | null {
  if (boardId === "epoch_eci") return epochEciIndex(epoch);
  if (boardId === "epoch_swe") return epochSweIndex(epoch);
  return rapIndex(boardId, rap);
}

export function boardList(rap: RapData, epoch: EpochData): Array<{ id: string; name: string; metric: string; snapshot: string; source: "rap" | "epoch" }> {
  return [
    ...rap.boards.map(board => ({ id: board.id, name: board.name, metric: board.metric, snapshot: board.snapshot, source: "rap" as const })),
    { id: "epoch_eci", name: "Epoch ECI", metric: "ECI", snapshot: epoch.snapshot, source: "epoch" as const },
    { id: "epoch_swe", name: "SWE-bench Verified (Epoch)", metric: "Pass@1 %", snapshot: epoch.snapshot, source: "epoch" as const },
  ];
}

// Manual aliases name one magpie model, so they key on the id as written
// (without the provider), not on the fuzzy-normalized form: "orbit-2" and
// "orbit-2-preview" must be mappable apart.
export function aliasKey(id: string): string {
  return stripProvider(String(id ?? "")).trim().toLowerCase();
}

function aliasFor(rawModel: string, state: ParetoState, aliases: Record<string, AliasEntry>): AliasEntry | null {
  const key = aliasKey(rawModel);
  const fromState = state.aliases[key];
  if (fromState && typeof fromState === "object" && fromState.model) return fromState;
  const fromFile = aliases[key];
  if (fromFile && typeof fromFile === "object" && fromFile.model) return fromFile;
  return null;
}

function entryFor(index: BoardIndex, canonical: string): BoardEntry | null {
  const normalized = normalizeModelId(canonical);
  const list = index.entries.get(normalized);
  if (!list || list.length !== 1) return null;
  return list[0];
}

export interface MatchDeps {
  state: ParetoState;
  aliases: Record<string, AliasEntry>;
  llm: LlmClient | null;
  onLlmCache?: (key: string, value: { model: string | null; effort?: string | null; at?: string }) => void;
}

export async function matchModel(rawModel: string, index: BoardIndex, deps: MatchDeps): Promise<MatchOutcome | null> {
  const normalized = normalizeModelId(rawModel);
  const manual = aliasFor(rawModel, deps.state, deps.aliases);
  if (manual) {
    return { model: manual.model, effort: manual.effort ?? null, kind: "manual", confirmed: true };
  }
  const list = index.entries.get(normalized);
  if (list && list.length === 1) {
    return { model: list[0].canonical, effort: null, kind: "fuzzy", confirmed: true };
  }
  if (!deps.llm) return null;
  const cacheKey = `${index.id}:${normalized}`;
  const cached = deps.state.llmMatches[cacheKey];
  if (cached) {
    if (!cached.model) return null;
    return { model: cached.model, effort: cached.effort ?? null, kind: "llm", confirmed: false };
  }
  if (deps.state.llmRejected[cacheKey]) return null;
  const candidates = [...new Set([...index.entries.values()].flat().map(entry => entry.canonical))];
  const answer = await deps.llm.ask(rawModel, candidates);
  const at = new Date().toISOString();
  if (answer) {
    const hit = candidates.find(candidate => candidate === answer) ?? candidates.find(candidate => normalizeModelId(candidate) === normalizeModelId(answer));
    if (hit) {
      deps.state.llmMatches[cacheKey] = { model: hit, effort: null, at };
      deps.onLlmCache?.(cacheKey, deps.state.llmMatches[cacheKey]);
      return { model: hit, effort: null, kind: "llm", confirmed: false };
    }
  }
  deps.state.llmMatches[cacheKey] = { model: null, at };
  deps.onLlmCache?.(cacheKey, deps.state.llmMatches[cacheKey]);
  return null;
}

export interface EffortPoint {
  effort: string;
  effortKey: string;
  score: number;
  harness: string;
}

// One point per (channel, model): take the best score the board has for an
// effort this channel actually supports. A channel without reasoning levels,
// or a board with no effort dimension, falls back to the model's best score.
export function scoreForEntry(entry: BoardEntry, reasoningLevels: string[]): EffortPoint | null {
  const effortKeys = [...entry.scores.keys()].filter(key => key !== "");
  if (!effortKeys.length) {
    const def = entry.scores.get("");
    return def ? { effort: "默认", effortKey: "", score: def.score, harness: def.harness } : null;
  }
  const supported = new Map<string, string>();
  for (const level of reasoningLevels) {
    const key = alignEffort(level);
    if (key && !supported.has(key)) supported.set(key, level);
  }
  let best: EffortPoint | null = null;
  for (const [key, score] of entry.scores) {
    if (!key) continue;
    if (supported.size && !supported.has(key)) continue;
    if (!best || score.score > best.score) {
      best = { effort: supported.get(key) ?? key, effortKey: key, score: score.score, harness: score.harness };
    }
  }
  return best;
}

export function resolveEntry(index: BoardIndex, match: MatchOutcome): BoardEntry | null {
  return entryFor(index, match.model);
}

export function makeLlmClient(gateway: string, model: string): LlmClient | null {
  if (!model) return null;
  return {
    model,
    ask: async (rawModel, candidates) => {
      const prompt = [
        "把 magpie 的模型 id 映射到榜单里的模型。",
        `模型 id: ${rawModel}`,
        `候选: ${JSON.stringify(candidates)}`,
        "只返回 JSON：{\"model\": \"候选之一或 null\", \"effort\": null}",
      ].join("\n");
      try {
        const response = await fetch(`${gateway}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            temperature: 0,
            messages: [
              { role: "system", content: "你只输出 JSON。" },
              { role: "user", content: prompt },
            ],
          }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) return null;
        const body: any = await response.json();
        const content = String(body?.choices?.[0]?.message?.content ?? "");
        const jsonText = content.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
        const parsed = JSON.parse(jsonText);
        return typeof parsed?.model === "string" && parsed.model.trim() ? parsed.model.trim() : null;
      } catch {
        return null;
      }
    },
  };
}
