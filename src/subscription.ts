import { resolvePaths, type Paths } from "./config";
import { DataStore, officialFor, readUsageLines, type DataBundle, type Price, type RapPlanPoint } from "./datasources";
import { resolveMagpieBin, runMagpie, type CommandResult } from "./magpie";
import { readState, type ParetoState, type Subscription } from "./state";
import { blendPrice, blendTokenSums, providerAverage, resolveProfile, summarizeUsage, type ProfileInfo, type TokenSums } from "./usage";
import { fmtNum, round } from "./util";

export interface SubscriptionPreviewRow {
  provider: string;
  model: string;
  mode: string;
  feeUsd: number;
  quotaUsd: number;
  discount: number;
  multiplier: number;
  official: Price;
  old: Price & { blended: number };
  next: Price;
  command: string;
}

export interface SubscriptionPreview {
  provider: string;
  mode: string;
  feeUsd: number;
  rows: SubscriptionPreviewRow[];
  warnings: string[];
  commands: string[];
}

const SCENARIO_ORDER = ["peak", "default", "mid", "offpeak", "day", "night"];

export interface PlanGroup {
  id: string;
  label: string;
  scenarios: Record<string, { priceUsd: number; rows: RapPlanPoint[] }>;
}

export function planGroups(plans: RapPlanPoint[]): PlanGroup[] {
  const groups = new Map<string, PlanGroup>();
  for (const row of plans) {
    let base = row.planId;
    let scenario = "default";
    for (const candidate of ["peak", "mid", "offpeak", "day", "night"]) {
      if (row.planId.endsWith(`_${candidate}`)) {
        base = row.planId.slice(0, -(candidate.length + 1));
        scenario = candidate;
        break;
      }
    }
    const group = groups.get(base) ?? { id: base, label: row.plan || base, scenarios: {} };
    const bucket = group.scenarios[scenario] ?? { priceUsd: row.priceUsd, rows: [] };
    bucket.priceUsd = row.priceUsd;
    bucket.rows.push(row);
    group.scenarios[scenario] = bucket;
    groups.set(base, group);
  }
  return [...groups.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function defaultScenario(group: PlanGroup): string {
  for (const scenario of SCENARIO_ORDER) if (group.scenarios[scenario]) return scenario;
  return Object.keys(group.scenarios)[0] ?? "default";
}

function feeUsdOf(subscription: Subscription): number {
  if (Number.isFinite(subscription.feeUsd) && Number(subscription.feeUsd) >= 0) return Number(subscription.feeUsd);
  if (Number.isFinite(subscription.feeCny) && Number(subscription.feeCny) >= 0) {
    if (!(Number(subscription.rate) > 0)) throw new Error("填 CNY 时必须同时填汇率");
    return Number(subscription.feeCny) / Number(subscription.rate);
  }
  throw new Error("缺少月费（USD 或 CNY + 汇率）");
}

function positive(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} 必须是正数`);
  return n;
}

function officialPriceFor(data: DataBundle, model: string): Price | null {
  return officialFor(data.catalog, model)?.cost ?? null;
}

function newPrices(official: Price, discount: number): Price {
  return {
    input: round(official.input * discount, 6),
    output: round(official.output * discount, 6),
    cache_read: round(official.cache_read * discount, 6),
    cache_write: round(official.cache_write * discount, 6),
  };
}

export function priceArg(price: Price): string {
  return [price.input, price.output, price.cache_read, price.cache_write].map(value => fmtNum(value, 6)).join(",");
}

export function priceCommand(provider: string, model: string, price: Price): string {
  return `magpie model price ${provider}/${model} ${priceArg(price)}`;
}

export interface PreviewInput {
  provider: string;
  subscription?: Subscription;
  plan?: { id: string; scenario?: string };
  profile?: string;
}

export async function previewSubscription(
  paths: Paths,
  store: DataStore,
  input: PreviewInput,
  state: ParetoState,
): Promise<SubscriptionPreview> {
  const data = await store.ensure();
  const usage = summarizeUsage(await readUsageLines(paths));
  const profile: ProfileInfo = resolveProfile(input.profile, usage);
  const subscription: Subscription = { ...(state.subscriptions[input.provider] ?? {}), ...(input.subscription ?? {}) };
  const warnings: string[] = [];
  const providerModels = data.gateway.filter(gateway => gateway.provider === input.provider && gateway.pricing);
  if (!providerModels.length) throw new Error(`渠道 ${input.provider} 没有可用模型`);

  const rows: SubscriptionPreviewRow[] = [];
  let mode = subscription.mode ?? "usd";
  let feeUsd = 0;

  if (input.plan) {
    const groups = planGroups(data.rap.plans);
    const group = groups.find(item => item.id === input.plan!.id);
    if (!group) throw new Error(`未知套餐 ${input.plan.id}`);
    const scenario = input.plan.scenario && group.scenarios[input.plan.scenario]
      ? input.plan.scenario
      : defaultScenario(group);
    const bucket = group.scenarios[scenario];
    if (!bucket) throw new Error(`套餐 ${group.id} 没有场景 ${scenario}`);
    feeUsd = bucket.priceUsd;
    mode = "plan";
    const previous = subscription.planSnapshot;
    if (previous) {
      for (const planRow of bucket.rows) {
        const before = previous.rows[planRow.model];
        if (!before) { warnings.push(`额度数据有更新：套餐新增了模型 ${planRow.model}`); continue; }
        if (Math.abs(before.priceUsd - planRow.priceUsd) > 1e-9
          || Math.abs(before.monthlyTokens - planRow.monthlyTokens) > 1e-6
          || Math.abs(before.listBlended - planRow.listBlended) > 1e-9) {
          warnings.push(`额度数据有更新：${planRow.model} 的套餐数据变了`);
        }
      }
    }
    for (const planRow of bucket.rows) {
      const channel = providerModels.find(model => model.model === planRow.model)
        ?? providerModels.find(model => model.model.toLowerCase() === planRow.model.toLowerCase());
      const official = officialPriceFor(data, planRow.model);
      if (!channel) { warnings.push(`渠道 ${input.provider} 里没有套餐模型 ${planRow.model}`); continue; }
      if (!official) { warnings.push(`${planRow.model} 没有官方价，跳过`); continue; }
      const quotaUsd = (planRow.monthlyTokens / 1e6) * planRow.listBlended;
      if (!(quotaUsd > 0)) { warnings.push(`${planRow.model} 的额度为 0，跳过`); continue; }
      const discount = feeUsd / quotaUsd;
      const next = newPrices(official, discount);
      rows.push({
        provider: input.provider,
        model: planRow.model,
        mode,
        feeUsd,
        quotaUsd,
        discount,
        multiplier: 1,
        official,
        old: { ...channel.pricing!, blended: blendPrice(channel.pricing!, profile.vector) },
        next,
        command: priceCommand(input.provider, planRow.model, next),
      });
    }
    return { provider: input.provider, mode, feeUsd, rows, warnings, commands: rows.map(row => row.command) };
  }

  feeUsd = feeUsdOf(subscription);
  for (const gateway of providerModels) {
    const official = officialPriceFor(data, gateway.model);
    if (!official) { warnings.push(`${gateway.model} 没有官方价，跳过`); continue; }
    let quotaUsd = 0;
    let multiplier = 1;
    if (mode === "usd") {
      quotaUsd = positive(subscription.quotaUsd, "等值美元额度");
    } else if (mode === "tokens") {
      const tokens = positive(subscription.tokens, "每月 token 额度");
      quotaUsd = (tokens / 1e6) * blendPrice(official, profile.vector);
    } else if (mode === "requests") {
      const windowHours = positive(subscription.windowHours, "时间窗小时数");
      const requests = positive(subscription.requests, "每时间窗请求数");
      const monthly = requests * ((28 * 24) / windowHours);
      const average: TokenSums | null = providerAverage(usage, input.provider);
      if (!average) throw new Error(`账本里没有渠道 ${input.provider} 的数据，请改用其它口径`);
      quotaUsd = monthly * blendTokenSums(average, official);
    } else if (mode === "credits") {
      quotaUsd = positive(subscription.quotaUsd, "1× 倍率下的额度等值美元");
      multiplier = Number(subscription.multipliers?.[gateway.model] ?? 1);
      if (!Number.isFinite(multiplier) || multiplier <= 0) multiplier = 1;
    } else {
      throw new Error(`未知额度口径 ${mode}`);
    }
    if (!(quotaUsd > 0)) throw new Error(`渠道 ${input.provider} 的额度换算为 0`);
    const discount = (feeUsd / quotaUsd) * multiplier;
    const next = newPrices(official, discount);
    rows.push({
      provider: input.provider,
      model: gateway.model,
      mode,
      feeUsd,
      quotaUsd,
      discount,
      multiplier,
      official,
      old: { ...gateway.pricing!, blended: blendPrice(gateway.pricing!, profile.vector) },
      next,
      command: priceCommand(input.provider, gateway.model, next),
    });
  }
  return { provider: input.provider, mode, feeUsd, rows, warnings, commands: rows.map(row => row.command) };
}

export interface ApplyResult {
  ok: boolean;
  preview: SubscriptionPreview;
  executed: CommandResult[];
  verified: boolean;
  mismatches: Array<{ model: string; expected: Price; actual: Price | null }>;
  error?: string;
}

export async function applySubscription(
  paths: Paths,
  store: DataStore,
  input: PreviewInput,
  state: ParetoState,
  dryRun: boolean,
  magpieBin?: string,
): Promise<ApplyResult> {
  const preview = await previewSubscription(paths, store, input, state);
  if (!preview.rows.length) return { ok: false, preview, executed: [], verified: false, mismatches: [], error: "没有可写回的行" };
  if (dryRun) return { ok: true, preview, executed: [], verified: false, mismatches: [] };
  const bin = resolveMagpieBin({ magpieBin });
  const executed: CommandResult[] = [];
  for (const row of preview.rows) {
    const result = await runMagpie(bin, ["model", "price", `${row.provider}/${row.model}`, priceArg(row.next)]);
    executed.push(result);
    if (result.code !== 0) {
      return { ok: false, preview, executed, verified: false, mismatches: [], error: `命令失败：${result.command}：${result.stderr.trim() || result.stdout.trim()}` };
    }
  }
  const after = await store.ensure();
  const mismatches: Array<{ model: string; expected: Price; actual: Price | null }> = [];
  for (const row of preview.rows) {
    const actual = after.gateway.find(gateway => gateway.provider === row.provider && gateway.model === row.model)?.pricing ?? null;
    if (!actual || !samePrice(actual, row.next)) mismatches.push({ model: row.model, expected: row.next, actual });
  }
  return { ok: mismatches.length === 0, preview, executed, verified: mismatches.length === 0, mismatches };
}

export function samePrice(a: Price, b: Price): boolean {
  const near = (x: number, y: number) => Math.abs(x - y) <= 1e-6;
  return near(a.input, b.input) && near(a.output, b.output) && near(a.cache_read, b.cache_read) && near(a.cache_write, b.cache_write);
}

export function planSnapshotFor(
  data: DataBundle,
  plan: { id: string; scenario?: string },
): Subscription["planSnapshot"] {
  const group = planGroups(data.rap.plans).find(item => item.id === plan.id);
  if (!group) return null;
  const scenario = plan.scenario && group.scenarios[plan.scenario] ? plan.scenario : defaultScenario(group);
  const bucket = group.scenarios[scenario];
  const rows: Record<string, { priceUsd: number; monthlyTokens: number; listBlended: number }> = {};
  for (const row of bucket.rows) {
    rows[row.model] = { priceUsd: row.priceUsd, monthlyTokens: row.monthlyTokens, listBlended: row.listBlended };
  }
  return { at: new Date().toISOString(), id: group.id, scenario, rows };
}

export async function subscriptionProviders(paths: Paths, store: DataStore, profileId: string) {
  const data = await store.ensure();
  const usage = summarizeUsage(await readUsageLines(paths));
  const profile = resolveProfile(profileId, usage);
  const state = await readState(paths);
  const providers = new Map<string, { id: string; models: Array<{ model: string; current: Price & { blended: number }; official: Price | null }> }>();
  for (const gateway of data.gateway) {
    if (!gateway.pricing) continue;
    const item = providers.get(gateway.provider) ?? { id: gateway.provider, models: [] };
    item.models.push({
      model: gateway.model,
      current: { ...gateway.pricing, blended: blendPrice(gateway.pricing, profile.vector) },
      official: officialPriceFor(data, gateway.model),
    });
    providers.set(gateway.provider, item);
  }
  return {
    profile: { id: profile.id, label: profile.label, vector: profile.vector },
    providers: [...providers.values()].sort((a, b) => a.id.localeCompare(b.id)),
    plans: planGroups(data.rap.plans).map(group => ({
      id: group.id,
      label: group.label,
      scenarios: Object.keys(group.scenarios),
      defaultScenario: defaultScenario(group),
    })),
    subscriptions: state.subscriptions,
  };
}

export { resolvePaths };
