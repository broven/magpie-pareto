import { atomicWriteJson, readJson } from "./util";
import { resolvePaths, type Paths } from "./config";

export interface AliasEntry {
  model: string;
  effort?: string | null;
  source?: string;
}

export interface SuspectEntry {
  suspect: boolean;
  factor?: number;
}

export interface Subscription {
  mode?: "usd" | "tokens" | "requests" | "credits";
  feeUsd?: number;
  feeCny?: number;
  rate?: number;
  quotaUsd?: number;
  tokens?: number;
  windowHours?: number;
  requests?: number;
  multipliers?: Record<string, number>;
  plan?: { id: string; scenario?: string } | null;
  planSnapshot?: {
    at: string;
    id: string;
    scenario: string;
    rows: Record<string, { priceUsd: number; monthlyTokens: number; listBlended: number }>;
  } | null;
}

export interface ParetoState {
  version: number;
  aliases: Record<string, AliasEntry>;
  manualScores: Record<string, Record<string, number>>;
  suspect: Record<string, SuspectEntry>;
  series: Record<string, string>;
  llmModel: string;
  llmMatches: Record<string, { model: string | null; effort?: string | null; at?: string }>;
  llmRejected: Record<string, boolean>;
  subscriptions: Record<string, Subscription>;
  hiddenProviders: string[];
  hiddenModels: string[];
}

export function defaultState(): ParetoState {
  return {
    version: 1,
    aliases: {},
    manualScores: {},
    suspect: {},
    series: {},
    llmModel: "",
    llmMatches: {},
    llmRejected: {},
    subscriptions: {},
    hiddenProviders: [],
    hiddenModels: [],
  };
}

export async function readState(paths: Paths = resolvePaths()): Promise<ParetoState> {
  const raw = await readJson<any>(paths.stateFile);
  const base = defaultState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const state: ParetoState = {
    version: 1,
    aliases: isObject(raw.aliases) ? raw.aliases : {},
    manualScores: isObject(raw.manualScores) ? raw.manualScores : {},
    suspect: isObject(raw.suspect) ? raw.suspect : {},
    series: isObject(raw.series) ? raw.series : {},
    llmModel: typeof raw.llmModel === "string" ? raw.llmModel : "",
    llmMatches: isObject(raw.llmMatches) ? raw.llmMatches : {},
    llmRejected: isObject(raw.llmRejected) ? raw.llmRejected : {},
    subscriptions: isObject(raw.subscriptions) ? raw.subscriptions : {},
    hiddenProviders: Array.isArray(raw.hiddenProviders)
      ? [...new Set(raw.hiddenProviders.map(String).filter(Boolean))]
      : [],
    hiddenModels: Array.isArray(raw.hiddenModels)
      ? [...new Set(raw.hiddenModels.map(String).filter(Boolean))]
      : [],
  };
  return state;
}

export async function writeState(state: ParetoState, paths: Paths = resolvePaths()): Promise<void> {
  await atomicWriteJson(paths.stateFile, state, 0o600);
}

function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function keyOf(provider: string, model: string): string {
  return `${provider}/${model}`;
}
