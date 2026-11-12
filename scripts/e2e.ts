import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { root, startFixtureStack } from "./fixtures";

const artifactDir = join(root, "artifacts");
await mkdir(artifactDir, { recursive: true, mode: 0o700 });
const artifactPath = join(artifactDir, `e2e-${new Date().toISOString().replaceAll(":", "-")}.json`);

const realProviders = join(homedir(), ".config/magpie/providers.json");
const realSettings = join(homedir(), ".config/magpie/settings.json");
async function digest(path: string): Promise<string | null> {
  try { return createHash("sha256").update(await readFile(path)).digest("hex"); } catch { return null; }
}
const hashBefore = { providers: await digest(realProviders), settings: await digest(realSettings) };

const stack = await startFixtureStack();
const { base, token, sandboxRoot } = stack;
const auth = () => ({ "x-pareto-token": token });
const artifact: any = {
  started: new Date().toISOString(),
  base,
  checks: [],
  hashBefore,
  sandbox: { root: sandboxRoot, home: stack.sandboxHome },
};

function check(label: string, detail: unknown) {
  artifact.checks.push({ label, status: "PASS", detail });
  console.log(`PASS ${label}`);
}

async function get(path: string) {
  const response = await fetch(base + path, { headers: auth() });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`);
  return response.json() as Promise<any>;
}

async function post(path: string, body: unknown) {
  const response = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth() },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`);
  return response.json() as Promise<any>;
}

function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, value);
  return search.toString();
}

async function chart(params: Record<string, string | undefined>) {
  return get(`/api/chart?${query(params)}`);
}

function pointOf(data: any, provider: string, model: string, effort: string) {
  return data.points.find((point: any) => point.provider === provider && point.model === model && point.effort === effort);
}

function pointOfModel(data: any, provider: string, model: string) {
  return data.points.find((point: any) => point.provider === provider && point.model === model);
}

const near = (a: number, b: number, epsilon = 1e-9) => Math.abs(a - b) <= epsilon;

try {
  await post("/api/refresh", {});
  await post("/api/state/llm", { model: "group/g1" });
  const c1 = await chart({ board: "aa_intelligence_index", profile: "group:g1" });
  artifact.chart = { points: c1.points.length, noScore: c1.noScore.length, links: c1.links.length, boards: c1.boards.length };

  // 1: only provider/model entries from /v1/models; group/* and auto/* skipped.
  const providers = new Set(c1.points.map((point: any) => point.provider));
  assert.deepEqual([...providers].sort(), ["chan-a", "chan-b"]);
  assert.ok(c1.points.every((point: any) => !point.model.startsWith("group/") && !point.model.startsWith("auto/")));
  assert.ok(c1.noScore.every((item: any) => ["chan-a", "chan-b", "mock-chan"].includes(item.provider)));
  assert.ok(!c1.points.some((point: any) => point.model === "no-price"));
  assert.equal(c1.boards.length, 10, "8 RAP boards plus ECI and SWE");
  check("1 only /v1/models provider/model entries; group and auto skipped", {
    providers: [...providers], boards: c1.boards.map((board: any) => board.id),
  });

  // 2: hand-calculated blended prices under all / group:g1 / 3:1.
  const cAll = await chart({ board: "aa_intelligence_index", profile: "all" });
  const cFixed = await chart({ board: "aa_intelligence_index", profile: "fixed:3:1" });
  const g1 = pointOfModel(c1, "chan-a", "falcon-9");
  const all = pointOfModel(cAll, "chan-a", "falcon-9");
  const fixed = pointOfModel(cFixed, "chan-a", "falcon-9");
  assert.ok(g1 && all && fixed);
  const expectedG1 = 0.1 * 2 + 0.05 * 10 + 0.8 * 0.2 + 0.05 * 2.5;
  const expectedAll = (500 / 2350) * 2 + (150 / 2350) * 10 + (1600 / 2350) * 0.2 + (100 / 2350) * 2.5;
  const expectedFixed = 0.75 * 2 + 0.25 * 10;
  assert.ok(near(g1.price.blended, expectedG1), `${g1.price.blended} != ${expectedG1}`);
  assert.ok(near(all.price.blended, expectedAll), `${all.price.blended} != ${expectedAll}`);
  assert.ok(near(fixed.price.blended, expectedFixed), `${fixed.price.blended} != ${expectedFixed}`);
  check("2 blended price under all / group:g1 / 3:1, error < 1e-9", {
    group: g1.price.blended, all: all.price.blended, fixed: fixed.price.blended,
  });

  // 3: a missing cache price falls back to the input price.
  const chanB = pointOf(c1, "chan-b", "falcon-9", "high");
  assert.ok(chanB);
  assert.ok(near(chanB.price.cache_read, chanB.price.input));
  assert.ok(near(chanB.price.cache_write, chanB.price.input));
  const expectedChanB = 0.1 * 2 + 0.05 * 10 + 0.8 * 2 + 0.05 * 2;
  assert.ok(near(chanB.price.blended, expectedChanB), `${chanB.price.blended} != ${expectedChanB}`);
  check("3 missing cache prices use the input price", { cache_read: chanB.price.cache_read, blended: chanB.price.blended });

  // 4: a free point sits in the free column.
  const free = pointOf(c1, "chan-a", "free-bee", "high");
  assert.ok(free);
  assert.equal(free.free, true);
  assert.equal(free.price.blended, 0);
  assert.equal(c1.freeColumn, true);
  check("4 free point in the free column", { model: "free-bee", blended: free.price.blended });

  // 5: one point per (channel, model); cross-channel solid link; an effort the
  // channel does not support never contributes to the score.
  const seenPoint = new Set<string>();
  for (const point of c1.points) {
    const key = `${point.provider}/${point.model}`;
    assert.ok(!seenPoint.has(key), `${key} must have exactly one point`);
    seenPoint.add(key);
  }
  assert.ok(c1.points.every((point: any) => !String(point.id).includes("::")), "point ids carry no effort suffix");
  assert.ok(!c1.links.some((link: any) => link.kind === "vertical"), "no per-effort vertical links");
  const horizontal = c1.links.find((link: any) => link.kind === "horizontal" && link.modelKey === "falcon-9");
  assert.ok(horizontal, "falcon-9 must link across channels");
  const linkedProviders = new Set(horizontal.points.map((point: any) => point.provider));
  assert.ok(linkedProviders.has("chan-a") && linkedProviders.has("chan-b"));
  const chanAFalcon = pointOfModel(c1, "chan-a", "falcon-9");
  const chanBFalcon = pointOfModel(c1, "chan-b", "falcon-9");
  assert.ok(chanAFalcon && chanBFalcon);
  // chan-a supports low/high/max: the max score wins.
  assert.equal(chanAFalcon.effort, "max");
  assert.equal(chanAFalcon.score, 70);
  // chan-b only supports high, so its score comes from the high tier (65), not max (70).
  assert.equal(chanBFalcon.effort, "high");
  assert.equal(chanBFalcon.score, 65);
  assert.equal(c1.points.filter((point: any) => point.provider === "chan-b" && point.model === "falcon-9").length, 1);
  check("5 one point per (channel, model); cross-channel solid link; channel without max scores at high", {
    chanA: `${chanAFalcon.effort}/${chanAFalcon.score}`, chanB: `${chanBFalcon.effort}/${chanBFalcon.score}`,
    horizontal: horizontal.points.length, vertical: c1.links.filter((link: any) => link.kind === "vertical").length,
  });

  // 6: the chart only draws real (channel, model) points; no official/reference points.
  assert.ok(!("officialPoints" in c1), "the chart response has no officialPoints field");
  assert.ok(c1.points.every((point: any) => point.official === undefined && !String(point.id).startsWith("official::")));
  check("6 chart has no official/reference points", { points: c1.points.length });

  // 6b: hiding a provider removes its points, no-score items and cross-channel
  // links, while the channel list still lists it as hidden; unhiding restores.
  const cBeforeHide = await chart({ board: "aa_intelligence_index", profile: "group:g1" });
  const chanBBefore = cBeforeHide.providers.find((provider: any) => provider.id === "chan-b");
  assert.ok(chanBBefore, "the channel list includes chan-b");
  assert.equal(chanBBefore.hidden, false);
  assert.equal(chanBBefore.modelCount, 2);
  assert.ok(cBeforeHide.points.some((point: any) => point.provider === "chan-b"));
  assert.ok(cBeforeHide.links.some((link: any) => link.modelKey === "falcon-9"));
  const hiddenState = await post("/api/state/providers", { provider: "chan-b", hidden: true });
  assert.deepEqual(hiddenState.hiddenProviders, ["chan-b"]);
  const cHidden = await chart({ board: "aa_intelligence_index", profile: "group:g1" });
  assert.ok(!cHidden.points.some((point: any) => point.provider === "chan-b"), "hidden channel draws no points");
  assert.ok(!cHidden.noScore.some((item: any) => item.provider === "chan-b"), "hidden channel draws no no-score items");
  assert.ok(!cHidden.links.some((link: any) => link.modelKey === "falcon-9"), "the cross-channel link is gone");
  const chanBHidden = cHidden.providers.find((provider: any) => provider.id === "chan-b");
  assert.ok(chanBHidden, "the channel list still includes the hidden channel");
  assert.equal(chanBHidden.hidden, true);
  assert.equal(chanBHidden.modelCount, 2);
  const stateWithHidden = await get("/api/state");
  assert.deepEqual(stateWithHidden.hiddenProviders, ["chan-b"]);
  await post("/api/state/providers", { provider: "chan-b", hidden: false });
  const cRestored = await chart({ board: "aa_intelligence_index", profile: "group:g1" });
  assert.ok(cRestored.points.some((point: any) => point.provider === "chan-b"), "unhiding restores the points");
  assert.ok(cRestored.links.some((link: any) => link.modelKey === "falcon-9"));
  assert.equal(cRestored.providers.find((provider: any) => provider.id === "chan-b").hidden, false);
  check("6b hidden channel drops points, no-score items and links; channel list keeps it", {
    hidden: chanBHidden.hidden, modelCount: chanBHidden.modelCount,
  });

  // 6c: the name-matching table lists unmatched models; a manual alias scores
  // the model and leaves the list; deleting the alias puts it back.
  const unmatchedBefore = await chart({ board: "aa_intelligence_index", profile: "group:g1" });
  const hy4free = unmatchedBefore.unmatched.find((item: any) => item.model === "hy4free");
  assert.ok(hy4free, "hy4free is unmatched");
  assert.deepEqual(hy4free.providers, ["mock-chan"]);
  assert.ok(unmatchedBefore.boardModels.includes("falcon-9"), "the board model list feeds the datalist");
  await post("/api/state/alias", { model: "hy4free", boardModel: "falcon-9" });
  const mapped = await chart({ board: "aa_intelligence_index", profile: "group:g1" });
  assert.ok(!mapped.unmatched.some((item: any) => item.model === "hy4free"), "the alias removes it from the unmatched list");
  const hyPoint = pointOfModel(mapped, "mock-chan", "hy4free");
  assert.ok(hyPoint, "the aliased model now scores");
  assert.equal(hyPoint.match.kind, "manual");
  assert.equal(hyPoint.score, 65);
  assert.ok(mapped.aliases.some((alias: any) => alias.model === "hy4free" && alias.boardModel === "falcon-9"));
  await post("/api/state/alias", { model: "hy4free", boardModel: "" });
  const unmatchedAgain = await chart({ board: "aa_intelligence_index", profile: "group:g1" });
  assert.ok(unmatchedAgain.unmatched.some((item: any) => item.model === "hy4free"), "deleting the alias restores the unmatched entry");
  assert.ok(!pointOfModel(unmatchedAgain, "mock-chan", "hy4free"), "deleting the alias removes the point");
  assert.ok(!unmatchedAgain.aliases.some((alias: any) => alias.model === "hy4free"));
  check("6c unmatched list; manual alias scores; alias delete restores", {
    unmatched: hy4free.providers, aliasedScore: hyPoint.score,
  });

  // 7: series, latest-generation filtering, cheap-old exception, allOld switch.
  const falcon9 = pointOfModel(c1, "chan-a", "falcon-9");
  const falcon8 = pointOf(c1, "chan-a", "falcon-8", "high");
  assert.ok(falcon9 && falcon8);
  assert.equal(falcon8.series, falcon9.series, "falcon-8 and falcon-9 share the series key");
  assert.equal(falcon8.oldGen, true);
  assert.ok(falcon8.price.blended < falcon9.price.blended, "the cheaper old generation stays visible");
  assert.ok(!pointOf(c1, "chan-a", "orbit-1", "high"), "the expensive old generation is hidden");
  const cAllOld = await chart({ board: "aa_intelligence_index", profile: "group:g1", allOld: "1" });
  const orbit1 = pointOf(cAllOld, "chan-a", "orbit-1", "high");
  const orbit2 = pointOf(cAllOld, "chan-a", "orbit-2", "high");
  assert.ok(orbit1 && orbit2);
  assert.equal(orbit1.series, orbit2.series);
  assert.equal(orbit1.oldGen, true);
  check("7 series; latest generation kept; cheap old kept, expensive old hidden unless allOld", {
    falcon8: falcon8.price.blended, falcon9: falcon9.price.blended, orbit1Shown: true,
  });

  // 8: matching priority manual > fuzzy > LLM; confirm turns an AI guess into manual.
  const manual = pointOf(c1, "chan-a", "orbit-2-preview", "high");
  const fuzzy = pointOf(c1, "chan-a", "falcon-9-preview", "high");
  const llm = pointOf(c1, "chan-b", "mystery-7", "high");
  assert.ok(manual && fuzzy && llm);
  assert.equal(manual.match.kind, "manual");
  assert.equal(manual.score, 45, "manual alias wins over the fuzzy orbit-2 score of 80");
  assert.equal(fuzzy.match.kind, "fuzzy");
  assert.equal(fuzzy.score, 65);
  assert.equal(llm.match.kind, "llm");
  assert.equal(llm.match.confirmed, false);
  const stateBeforeConfirm = await get("/api/state");
  assert.equal(stateBeforeConfirm.llmMatches["aa_intelligence_index:mystery-7"]?.model, "falcon-9");
  assert.equal(stateBeforeConfirm.llmMatches["aa_intelligence_index:loner-1"]?.model, null);
  await post("/api/state/match", { provider: "chan-b", model: "mystery-7", board: "aa_intelligence_index", action: "confirm" });
  const cConfirmed = await chart({ board: "aa_intelligence_index", profile: "group:g1" });
  const confirmed = pointOf(cConfirmed, "chan-b", "mystery-7", "high");
  assert.ok(confirmed);
  assert.equal(confirmed.match.kind, "manual");
  assert.equal(confirmed.match.confirmed, true);
  check("8 manual > fuzzy > LLM; AI guess marked and confirmable", {
    manual: manual.score, fuzzy: fuzzy.score, llm: llm.match.kind, confirmed: confirmed.match.kind,
  });

  // 9: no-score band and manual scoring.
  const before = c1.noScore.find((item: any) => item.provider === "chan-a" && item.model === "loner-1");
  assert.ok(before, "loner-1 has a price but no score");
  await post("/api/state/manual-score", { board: "aa_intelligence_index", provider: "chan-a", model: "loner-1", score: 42 });
  const cManual = await chart({ board: "aa_intelligence_index", profile: "group:g1" });
  const manualPoint = pointOf(cManual, "chan-a", "loner-1", "默认");
  assert.ok(manualPoint);
  assert.equal(manualPoint.manual, true);
  assert.equal(manualPoint.score, 42);
  assert.equal(manualPoint.scoreSource, "手动");
  assert.ok(!cManual.noScore.some((item: any) => item.provider === "chan-a" && item.model === "loner-1"));
  check("9 no-score band and manual score", { before: before.price.blended, score: manualPoint.score });

  // 10: suspect factor scales the score.
  await post("/api/state/suspect", { provider: "chan-a", model: "falcon-9", suspect: true, factor: 0.8 });
  const cSuspect = await chart({ board: "aa_intelligence_index", profile: "group:g1" });
  const suspectTop = pointOfModel(cSuspect, "chan-a", "falcon-9");
  assert.ok(suspectTop);
  assert.equal(suspectTop.suspect, true);
  assert.ok(near(suspectTop.score, 70 * 0.8));
  check("10 suspect factor", { score: suspectTop.score, effort: suspectTop.effort });

  // 11: four quota modes and RAP prefill with per-model discounts.
  const profile = "group:g1";
  const usd = await post("/api/subscription/preview", {
    provider: "chan-a", profile, subscription: { mode: "usd", feeUsd: 20, quotaUsd: 1000 },
  });
  const usdRow = usd.rows.find((row: any) => row.model === "falcon-9");
  assert.ok(usdRow);
  assert.ok(near(usdRow.discount, 0.02));
  assert.ok(near(usdRow.next.input, 0.08) && near(usdRow.next.output, 0.4)
    && near(usdRow.next.cache_read, 0.01) && near(usdRow.next.cache_write, 0.08));
  const tokens = await post("/api/subscription/preview", {
    provider: "chan-a", profile, subscription: { mode: "tokens", feeUsd: 20, tokens: 100_000_000 },
  });
  const tokenRow = tokens.rows.find((row: any) => row.model === "falcon-9");
  assert.ok(tokenRow);
  assert.ok(near(tokenRow.quotaUsd, 200), `quota ${tokenRow.quotaUsd}`);
  assert.ok(near(tokenRow.discount, 0.1));
  const requests = await post("/api/subscription/preview", {
    provider: "chan-a", profile, subscription: { mode: "requests", feeUsd: 20, windowHours: 8, requests: 1000 },
  });
  const requestRow = requests.rows.find((row: any) => row.model === "falcon-9");
  assert.ok(requestRow);
  const expectedQuota = 1000 * ((28 * 24) / 8) * ((200 * 4 + 50 * 20 + 400 * 0.5 + 25 * 4) / 1e6);
  assert.ok(near(requestRow.quotaUsd, expectedQuota), `${requestRow.quotaUsd} != ${expectedQuota}`);
  assert.ok(near(requestRow.discount, 20 / expectedQuota));
  const credits = await post("/api/subscription/preview", {
    provider: "chan-a", profile, subscription: { mode: "credits", feeUsd: 20, quotaUsd: 100, multipliers: { "falcon-9": 2 } },
  });
  const creditRow = credits.rows.find((row: any) => row.model === "falcon-9");
  assert.ok(creditRow);
  assert.ok(near(creditRow.discount, 0.4));
  const plan = await post("/api/subscription/preview", { provider: "chan-a", profile, plan: { id: "fake_plan" } });
  const planFalcon = plan.rows.find((row: any) => row.model === "falcon-9");
  const planMini = plan.rows.find((row: any) => row.model === "falcon-9-mini");
  assert.ok(planFalcon && planMini, "prefill lists each plan model separately");
  assert.ok(near(planFalcon.discount, 0.1));
  assert.ok(near(planMini.discount, 0.4));
  assert.equal(planFalcon.mode, "plan");
  check("11 subscription modes usd/tokens/requests/credits and RAP prefill", {
    usd: usdRow.discount, tokens: tokenRow.discount, requests: requestRow.discount, credits: creditRow.discount,
    planFalcon: planFalcon.discount, planMini: planMini.discount,
  });

  // 12: real magpie CLI in the sandbox, then readback; real config untouched.
  const dry = await post("/api/subscription/apply", {
    provider: "chan-a", profile, subscription: { mode: "usd", feeUsd: 20, quotaUsd: 1000 }, dryRun: true,
  });
  assert.equal(dry.ok, true);
  assert.equal(dry.executed.length, 0);
  const expectedCommand = "magpie model price chan-a/falcon-9 0.08,0.4,0.01,0.08";
  assert.ok(dry.preview.commands.includes(expectedCommand), dry.preview.commands.join(" | "));
  const applied = await post("/api/subscription/apply", {
    provider: "chan-a", profile, subscription: { mode: "usd", feeUsd: 20, quotaUsd: 1000 }, dryRun: false,
  });
  assert.equal(applied.ok, true, applied.error ?? JSON.stringify(applied.mismatches));
  assert.equal(applied.verified, true);
  assert.ok(applied.executed.length > 0);
  const sandboxSettings = JSON.parse(await readFile(join(sandboxRoot, "magpie/settings.json"), "utf8"));
  const written = sandboxSettings.modelPrices["chan-a/falcon-9"];
  assert.ok(near(written.input, 0.08) && near(written.output, 0.4)
    && near(written.cache_read, 0.01) && near(written.cache_write, 0.08));
  const groupPreview = await post("/api/group/preview", { group: "g1", provider: "chan-a", model: "orbit-2", mode: "append" });
  assert.equal(groupPreview.ok, true);
  assert.deepEqual(groupPreview.after, ["chan-a/falcon-9", "chan-b/falcon-9", "chan-a/orbit-2"]);
  assert.ok(groupPreview.command.includes("models+=chan-a/orbit-2"));
  const groupApplied = await post("/api/group/apply", { group: "g1", provider: "chan-a", model: "orbit-2", mode: "append", dryRun: false });
  assert.equal(groupApplied.ok, true, groupApplied.error);
  assert.match(groupApplied.readBack, /orbit-2/);
  const sandboxProviders = JSON.parse(await readFile(join(sandboxRoot, "magpie/providers.json"), "utf8"));
  assert.ok(sandboxProviders.groups.find((group: any) => group.id === "g1").members.includes("chan-a/orbit-2"));
  const replaced = await post("/api/group/apply", { group: "g1", provider: "chan-a", model: "falcon-9-mini", mode: "replace", dryRun: false });
  assert.equal(replaced.ok, true, replaced.error);
  assert.match(replaced.readBack, /falcon-9-mini/);
  const sandboxProviders2 = JSON.parse(await readFile(join(sandboxRoot, "magpie/providers.json"), "utf8"));
  assert.deepEqual(sandboxProviders2.groups.find((group: any) => group.id === "g1").members, ["chan-a/falcon-9-mini"]);
  const hashAfter = { providers: await digest(realProviders), settings: await digest(realSettings) };
  assert.equal(hashAfter.providers, hashBefore.providers, "the real providers.json must stay byte-for-byte unchanged");
  assert.equal(hashAfter.settings, hashBefore.settings, "the real settings.json must stay byte-for-byte unchanged");
  check("12 real CLI apply in sandbox; price and group readback; real config hashes unchanged", {
    commands: dry.preview.commands.length, executed: applied.executed.length, groupReadBack: groupApplied.readBack.split("\n").filter(Boolean).slice(0, 2),
    hashBefore, hashAfter,
  });

  // 13: the service guard.
  const status = async (headers: Record<string, string>, path = "/api/chart?board=aa_intelligence_index", method = "GET") =>
    (await fetch(base + path, { method, headers })).status;
  assert.equal(await status({}), 403, "no token must be refused");
  assert.equal(await status({ ...auth(), host: "evil.example" }), 403, "a foreign host must be refused");
  assert.equal(await status({ ...auth(), origin: "https://evil.example" }), 403, "a foreign origin must be refused");
  const framed = await fetch(base + "/api/chart?board=aa_intelligence_index", { headers: { ...auth(), origin: "null" } });
  assert.equal(framed.status, 200);
  assert.equal(framed.headers.get("access-control-allow-origin"), "null");
  const preflight = await fetch(base + "/api/chart", {
    method: "OPTIONS",
    headers: { origin: "null", "access-control-request-method": "POST", "access-control-request-headers": "content-type, x-pareto-token" },
  });
  assert.equal(preflight.status, 204);
  const index = await fetch(base + "/", { headers: { origin: "null" } });
  assert.equal(index.headers.get("access-control-allow-origin"), null, "the HTML holding the token carries no CORS header");
  const framePage = await readFile(join(root, "page/index.html"), "utf8");
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/i.test(framePage), false, "page/index.html must have no inline script");
  check("13 no token / foreign host / foreign origin refused; Origin null allowed", {
    refused: ["no token", "foreign host", "foreign origin"], allowed: "Origin null + token",
  });

  // Epoch sources feed the board list and a default-effort point.
  await post("/api/state/suspect", { provider: "chan-a", model: "falcon-9", suspect: false });
  const eci = await chart({ board: "epoch_eci", profile: "group:g1" });
  const eciPoint = pointOf(eci, "chan-a", "falcon-9", "默认");
  assert.ok(eciPoint, "ECI has no effort dimension and draws a default point");
  assert.equal(eciPoint.score, 150);
  const swe = await chart({ board: "epoch_swe", profile: "group:g1" });
  const sweFalcon = pointOfModel(swe, "chan-a", "falcon-9");
  assert.ok(sweFalcon);
  assert.equal(sweFalcon.effort, "max");
  assert.equal(sweFalcon.score, 70);
  check("14 Epoch ECI and SWE boards", { eci: eciPoint.score, sweEffort: sweFalcon.effort, sweScore: sweFalcon.score });

  artifact.status = "PASS";
  console.log("E2E PASS");
} catch (error: any) {
  artifact.status = "FAIL";
  artifact.error = error?.stack ?? String(error);
  console.error(artifact.error);
  process.exitCode = 1;
} finally {
  artifact.finished = new Date().toISOString();
  await writeFile(artifactPath, JSON.stringify(artifact, null, 2), { mode: 0o600 });
  await stack.close(artifact.status !== "PASS");
  console.log(`artifacts: ${artifactPath}`);
}
