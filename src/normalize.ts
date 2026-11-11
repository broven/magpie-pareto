// Model id normalization, shared by matching, official-price lookup and
// series keys. The rules are the design's: strip the provider prefix, lower
// case, unify "." and "-", drop date suffixes and release markers, keep tier
// words (pro, flash, max…).
export function stripProvider(id: string): string {
  const slash = id.indexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}

export function normalizeModelId(id: string): string {
  let value = stripProvider(String(id ?? "")).trim().toLowerCase();
  value = value.replace(/[._\s]+/g, "-");
  // Date snapshots: -1017, -20260917, _20251001.
  value = value.replace(/[-_](?:19|20)\d{6}$/g, "");
  value = value.replace(/[-_]\d{4}$/g, "");
  // Release markers that say nothing about the model itself.
  // "free" is a channel's label for a free tier of the same model
  // (deepseek-v4.1-flash-free), not part of the model's identity.
  for (const marker of ["free", "preview", "experimental", "exp", "beta", "alpha", "latest", "new", "rc"]) {
    value = value.replace(new RegExp(`[-_]${marker}\\d*$`, "g"), "");
  }
  value = value.replace(/[^a-z0-9.-]+/g, "-");
  value = value.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  return value;
}

const TIER_WORDS = [
  "ultraspeed", "highspeed", "flashx", "flash", "pro", "max", "plus", "air",
  "mini", "nano", "omni", "vision", "lite", "code", "chat",
];

export function tierSuffix(id: string): string {
  const value = normalizeModelId(id);
  const parts = value.split("-");
  for (const tier of TIER_WORDS) {
    if (parts.includes(tier)) return tier;
  }
  const scale = /(\d+(?:\.\d+)?b(?:-a\d+(?:\.\d+)?b)?)/.exec(value);
  if (scale) return scale[1];
  const version = /(?:^|-)(v\d+)$/.exec(value);
  if (version) return version[1];
  return "";
}

export function seriesKey(id: string, family: string | undefined): string {
  const base = (family && family.trim()) || normalizeModelId(id);
  const tier = tierSuffix(id);
  return tier ? `${base}·${tier}` : base;
}
