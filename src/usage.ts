export interface TokenSums {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export interface ProfileVector extends TokenSums {}

export interface UsageSummary {
  all: TokenSums;
  requests: number;
  groups: Map<string, TokenSums>;
  agents: Map<string, TokenSums>;
  providers: Map<string, { sum: TokenSums; requests: number }>;
  windowDays: number;
}

const ZERO: TokenSums = { input: 0, output: 0, cache_read: 0, cache_write: 0 };

function add(target: TokenSums, row: any): void {
  target.input += Math.max(0, Number(row.in) || 0);
  target.output += Math.max(0, Number(row.out) || 0);
  target.cache_read += Math.max(0, Number(row.cache_read) || 0);
  target.cache_write += Math.max(0, Number(row.cache_write) || 0);
}

function sums(): TokenSums {
  return { ...ZERO };
}

export function summarizeUsage(rows: any[], now = Date.now(), windowDays = 30): UsageSummary {
  const summary: UsageSummary = {
    all: sums(),
    requests: 0,
    groups: new Map(),
    agents: new Map(),
    providers: new Map(),
    windowDays,
  };
  const floor = now - windowDays * 24 * 3600_000;
  for (const row of rows) {
    const time = Date.parse(String(row?.t ?? ""));
    if (!Number.isFinite(time) || time < floor || time > now + 3600_000) continue;
    summary.requests++;
    add(summary.all, row);
    const req = String(row?.req ?? "");
    if (req.startsWith("group/")) {
      const id = req.slice("group/".length);
      if (id) {
        const bucket = summary.groups.get(id) ?? sums();
        add(bucket, row);
        summary.groups.set(id, bucket);
      }
    }
    const agent = String(row?.agent ?? "");
    if (agent) {
      const bucket = summary.agents.get(agent) ?? sums();
      add(bucket, row);
      summary.agents.set(agent, bucket);
    }
    const provider = String(row?.provider ?? "");
    if (provider) {
      const bucket = summary.providers.get(provider) ?? { sum: sums(), requests: 0 };
      add(bucket.sum, row);
      bucket.requests++;
      summary.providers.set(provider, bucket);
    }
  }
  return summary;
}

function shares(sum: TokenSums): ProfileVector {
  const total = sum.input + sum.output + sum.cache_read + sum.cache_write;
  if (!(total > 0)) return { ...ZERO };
  return {
    input: sum.input / total,
    output: sum.output / total,
    cache_read: sum.cache_read / total,
    cache_write: sum.cache_write / total,
  };
}

export interface ProfileInfo {
  id: string;
  label: string;
  vector: ProfileVector;
  tokens: TokenSums;
}

export const FIXED_PROFILES: Array<{ id: string; label: string; vector: ProfileVector }> = [
  { id: "fixed:3:1", label: "3:1（input:output，不计 cache）", vector: { input: 0.75, output: 0.25, cache_read: 0, cache_write: 0 } },
  { id: "fixed:input", label: "只看 input", vector: { input: 1, output: 0, cache_read: 0, cache_write: 0 } },
  { id: "fixed:output", label: "只看 output", vector: { input: 0, output: 1, cache_read: 0, cache_write: 0 } },
];

export function listProfiles(summary: UsageSummary): ProfileInfo[] {
  const out: ProfileInfo[] = [
    { id: "all", label: `全部（最近 ${summary.windowDays} 天）`, vector: shares(summary.all), tokens: summary.all },
  ];
  for (const [id, sum] of [...summary.groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    out.push({ id: `group:${id}`, label: `组 ${id}`, vector: shares(sum), tokens: sum });
  }
  for (const [agent, sum] of [...summary.agents.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    out.push({ id: `agent:${agent}`, label: `agent ${agent}`, vector: shares(sum), tokens: sum });
  }
  for (const fixed of FIXED_PROFILES) {
    out.push({ id: fixed.id, label: fixed.label, vector: fixed.vector, tokens: { ...ZERO } });
  }
  return out;
}

export function resolveProfile(id: string | undefined, summary: UsageSummary): ProfileInfo {
  const profiles = listProfiles(summary);
  const wanted = id && id.trim() ? id.trim() : "all";
  const hit = profiles.find(profile => profile.id === wanted);
  if (hit) return hit;
  return profiles[0];
}

export function providerAverage(summary: UsageSummary, provider: string): TokenSums | null {
  const bucket = summary.providers.get(provider);
  if (!bucket || !bucket.requests) return null;
  return {
    input: bucket.sum.input / bucket.requests,
    output: bucket.sum.output / bucket.requests,
    cache_read: bucket.sum.cache_read / bucket.requests,
    cache_write: bucket.sum.cache_write / bucket.requests,
  };
}

export function blendPrice(price: { input: number; output: number; cache_read: number; cache_write: number }, vector: ProfileVector): number {
  return price.input * vector.input + price.output * vector.output + price.cache_read * vector.cache_read + price.cache_write * vector.cache_write;
}

export function blendTokenSums(tokens: TokenSums, price: { input: number; output: number; cache_read: number; cache_write: number }): number {
  return (tokens.input * price.input + tokens.output * price.output + tokens.cache_read * price.cache_read + tokens.cache_write * price.cache_write) / 1e6;
}
