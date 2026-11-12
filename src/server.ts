import { dirname, extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { resolvePaths, type Paths } from "./config";
import { DataStore, readGroups, type GatewayModel } from "./datasources";
import { computeChart } from "./chart";
import { normalizeModelId } from "./normalize";
import { aliasKey } from "./matching";
import { readState, writeState, type ParetoState, type Subscription } from "./state";
import { applySubscription, planSnapshotFor, previewSubscription, subscriptionProviders } from "./subscription";
import { applyGroup, previewGroup } from "./groups";
import { resolveMagpieBin, type ServiceOptions } from "./magpie";

export type { ServiceOptions };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8" },
});
const failure = (status: number, error: string, extra: Record<string, unknown> = {}) => json({ error, ...extra }, status);

export const TOKEN_HEADER = "x-pareto-token";
const TOKEN = randomBytes(32).toString("hex");

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const uiDir = join(root, "ui");
const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
};

function ownHosts(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
}

function originAllowed(origin: string | null, port: number): boolean {
  if (origin === null || origin === "null") return true;
  return [...ownHosts(port)].some(host => origin === `http://${host}`);
}

function tokenOK(request: Request): boolean {
  const got = Buffer.from(request.headers.get(TOKEN_HEADER) ?? "");
  const want = Buffer.from(TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
}

function withCors(response: Response, origin: string | null): Response {
  response.headers.set("access-control-allow-origin", origin && origin !== "null" ? origin : "null");
  response.headers.set("access-control-allow-headers", `content-type, ${TOKEN_HEADER}`);
  response.headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  response.headers.set("vary", "Origin");
  return response;
}

async function staticResponse(pathname: string): Promise<Response | null> {
  const rel = pathname === "/" ? "index.html" : pathname.startsWith("/ui/") ? pathname.slice(4) : "";
  if (!rel || rel.includes("\0") || rel.split("/").some(part => part === "..")) return null;
  const file = join(uiDir, rel);
  if (!file.startsWith(uiDir + sep)) return null;
  const body = Bun.file(file);
  if (!(await body.exists())) return null;
  return new Response(body, {
    headers: {
      "content-type": contentTypes[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    },
  });
}

async function indexResponse(): Promise<Response | null> {
  const file = Bun.file(join(uiDir, "index.html"));
  if (!(await file.exists())) return null;
  const html = (await file.text()).replace("</head>", `<meta name="pareto-token" content="${TOKEN}">\n</head>`);
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function boolParam(value: string | null): boolean {
  return value === "1" || value === "true" || value === "yes";
}

function parseMode(value: unknown): "replace" | "append" {
  return value === "append" ? "append" : "replace";
}

async function readBody(request: Request): Promise<any> {
  try { return await request.json(); } catch { throw new Error("请求体不是 JSON"); }
}

function mergeSubscription(state: ParetoState, provider: string, incoming: Subscription, snapshot?: Subscription["planSnapshot"]): Subscription {
  const current = state.subscriptions[provider] ?? {};
  const next: Subscription = { ...current, ...incoming };
  if (incoming.plan !== undefined) next.plan = incoming.plan;
  if (snapshot !== undefined) next.planSnapshot = snapshot;
  return next;
}

function makeFetch(paths: Paths, store: DataStore, magpieBin: string) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const method = request.method;
    try {
      if (method === "GET" && url.pathname === "/") {
        return (await indexResponse()) ?? failure(404, "not found");
      }
      if (method === "GET" && url.pathname.startsWith("/ui/")) {
        return (await staticResponse(url.pathname)) ?? failure(404, "not found");
      }
      if (method === "GET" && url.pathname === "/api/chart") {
        const chart = await computeChart(paths, store, {
          board: url.searchParams.get("board") ?? undefined,
          profile: url.searchParams.get("profile") ?? undefined,
          scale: url.searchParams.get("scale") ?? undefined,
          group: url.searchParams.get("group") ?? undefined,
          allOld: boolParam(url.searchParams.get("allOld")),
        });
        return json(chart);
      }
      if (method === "POST" && url.pathname === "/api/refresh") {
        const result = await store.refreshAll();
        return json({ ok: true, warnings: result.warnings });
      }
      if (method === "GET" && url.pathname === "/api/state") {
        return json(await readState(paths));
      }
      if (method === "POST" && url.pathname === "/api/state/alias") {
        const body = await readBody(request);
        const model = String(body?.model ?? "").trim();
        const boardModel = String(body?.boardModel ?? "").trim();
        if (!model) return failure(400, "model 不能为空");
        const state = await readState(paths);
        if (!boardModel) delete state.aliases[aliasKey(model)];
        else {
          state.aliases[aliasKey(model)] = {
            model: boardModel,
            effort: body?.effort == null || body.effort === "" ? null : String(body.effort),
            source: "user",
          };
        }
        await writeState(state, paths);
        return json({ ok: true, aliases: state.aliases });
      }
      if (method === "POST" && url.pathname === "/api/state/providers") {
        const body = await readBody(request);
        const provider = String(body?.provider ?? "").trim();
        if (!provider) return failure(400, "provider 不能为空");
        const state = await readState(paths);
        const hidden = new Set(state.hiddenProviders);
        if (body?.hidden === true) hidden.add(provider);
        else hidden.delete(provider);
        state.hiddenProviders = [...hidden].sort();
        await writeState(state, paths);
        return json({ ok: true, hiddenProviders: state.hiddenProviders });
      }
      if (method === "POST" && url.pathname === "/api/state/hidden-model") {
        const body = await readBody(request);
        const model = String(body?.model ?? "").trim();
        if (!model) return failure(400, "model 不能为空");
        const state = await readState(paths);
        const hidden = new Set(state.hiddenModels);
        if (body?.hidden === true) hidden.add(model);
        else hidden.delete(model);
        state.hiddenModels = [...hidden].sort();
        await writeState(state, paths);
        return json({ ok: true, hiddenModels: state.hiddenModels });
      }
      if (method === "POST" && url.pathname === "/api/state/manual-score") {
        const body = await readBody(request);
        const board = String(body?.board ?? "").trim();
        const provider = String(body?.provider ?? "").trim();
        const model = String(body?.model ?? "").trim();
        if (!board || !provider || !model) return failure(400, "board、provider、model 都不能为空");
        const state = await readState(paths);
        const scores = state.manualScores[board] ?? {};
        if (body?.score === null || body?.score === undefined || body?.score === "") delete scores[`${provider}/${model}`];
        else {
          const score = Number(body.score);
          if (!Number.isFinite(score)) return failure(400, "score 必须是数字");
          scores[`${provider}/${model}`] = score;
        }
        state.manualScores[board] = scores;
        await writeState(state, paths);
        return json({ ok: true, manualScores: state.manualScores });
      }
      if (method === "POST" && url.pathname === "/api/state/suspect") {
        const body = await readBody(request);
        const provider = String(body?.provider ?? "").trim();
        const model = String(body?.model ?? "").trim();
        if (!provider || !model) return failure(400, "provider 和 model 都不能为空");
        const state = await readState(paths);
        const key = `${provider}/${model}`;
        if (body?.suspect === false) delete state.suspect[key];
        else {
          const factor = body?.factor === undefined || body?.factor === "" ? 1 : Number(body.factor);
          if (!Number.isFinite(factor) || factor <= 0) return failure(400, "factor 必须是正数");
          state.suspect[key] = { suspect: true, factor };
        }
        await writeState(state, paths);
        return json({ ok: true, suspect: state.suspect });
      }
      if (method === "POST" && url.pathname === "/api/state/series") {
        const body = await readBody(request);
        const model = String(body?.model ?? "").trim();
        if (!model) return failure(400, "model 不能为空");
        const state = await readState(paths);
        const key = normalizeModelId(model);
        if (body?.series === null || body?.series === "") delete state.series[key];
        else state.series[key] = String(body.series);
        await writeState(state, paths);
        return json({ ok: true, series: state.series });
      }
      if (method === "POST" && url.pathname === "/api/state/llm") {
        const body = await readBody(request);
        const state = await readState(paths);
        state.llmModel = String(body?.model ?? "").trim();
        await writeState(state, paths);
        return json({ ok: true, llmModel: state.llmModel });
      }
      if (method === "POST" && url.pathname === "/api/state/match") {
        const body = await readBody(request);
        const provider = String(body?.provider ?? "").trim();
        const model = String(body?.model ?? "").trim();
        const board = String(body?.board ?? "").trim();
        if (!provider || !model || !board) return failure(400, "provider、model、board 都不能为空");
        const state = await readState(paths);
        const key = `${board}:${normalizeModelId(model)}`;
        const cached = state.llmMatches[key];
        if (body?.action === "confirm") {
          if (!cached?.model) return failure(400, "没有可确认的 AI 猜测");
          state.aliases[aliasKey(model)] = {
            model: cached.model,
            effort: cached.effort ?? null,
            source: "llm-confirmed",
          };
          delete state.llmMatches[key];
        } else if (body?.action === "reject") {
          delete state.llmMatches[key];
          state.llmRejected[key] = true;
        } else {
          return failure(400, "action 必须是 confirm 或 reject");
        }
        await writeState(state, paths);
        return json({ ok: true, aliases: state.aliases });
      }
      if (method === "POST" && url.pathname === "/api/state/subscription") {
        const body = await readBody(request);
        const provider = String(body?.provider ?? "").trim();
        if (!provider) return failure(400, "provider 不能为空");
        const state = await readState(paths);
        const incoming: Subscription = body?.subscription ?? {};
        let snapshot: Subscription["planSnapshot"] | undefined;
        if (incoming.plan?.id) {
          const data = await store.ensure();
          snapshot = planSnapshotFor(data, incoming.plan);
        }
        state.subscriptions[provider] = mergeSubscription(state, provider, incoming, snapshot);
        await writeState(state, paths);
        return json({ ok: true, subscription: state.subscriptions[provider] });
      }
      if (method === "GET" && url.pathname === "/api/subscription") {
        return json(await subscriptionProviders(paths, store, url.searchParams.get("profile") ?? "all"));
      }
      if (method === "POST" && url.pathname === "/api/subscription/preview") {
        const body = await readBody(request);
        const provider = String(body?.provider ?? "").trim();
        if (!provider) return failure(400, "provider 不能为空");
        const state = await readState(paths);
        const preview = await previewSubscription(paths, store, {
          provider,
          subscription: body?.subscription,
          plan: body?.plan,
          profile: body?.profile,
        }, state);
        return json(preview);
      }
      if (method === "POST" && url.pathname === "/api/subscription/apply") {
        const body = await readBody(request);
        const provider = String(body?.provider ?? "").trim();
        if (!provider) return failure(400, "provider 不能为空");
        const state = await readState(paths);
        const result = await applySubscription(paths, store, {
          provider,
          subscription: body?.subscription,
          plan: body?.plan,
          profile: body?.profile,
        }, state, body?.dryRun !== false, magpieBin);
        return json(result, result.ok ? 200 : 400);
      }
      if (method === "POST" && url.pathname === "/api/group/preview") {
        const body = await readBody(request);
        const group = String(body?.group ?? "").trim();
        const provider = String(body?.provider ?? "").trim();
        const model = String(body?.model ?? "").trim();
        if (!group || !provider || !model) return failure(400, "group、provider、model 都不能为空");
        return json(previewGroup(paths, group, provider, model, parseMode(body?.mode)));
      }
      if (method === "POST" && url.pathname === "/api/group/apply") {
        const body = await readBody(request);
        const group = String(body?.group ?? "").trim();
        const provider = String(body?.provider ?? "").trim();
        const model = String(body?.model ?? "").trim();
        if (!group || !provider || !model) return failure(400, "group、provider、model 都不能为空");
        const result = await applyGroup(paths, group, provider, model, parseMode(body?.mode), body?.dryRun !== false, magpieBin);
        return json(result, result.ok ? 200 : 400);
      }
      if (method === "GET" && url.pathname === "/api/meta") {
        const data = await store.ensure();
        const state = await readState(paths);
        return json({
          groups: readGroups(paths),
          llmModel: state.llmModel,
          cacheDates: data.cacheDates,
          gateway: data.gateway.map((model: GatewayModel) => ({ provider: model.provider, model: model.model, pricing: model.pricing, reasoningLevels: model.reasoningLevels })),
        });
      }
      return failure(404, "not found");
    } catch (error: any) {
      return failure(500, error?.message ?? String(error));
    }
  };
}

export interface RunningService {
  server: ReturnType<typeof Bun.serve>;
  port: number;
}

export async function startService(options: ServiceOptions = {}): Promise<RunningService> {
  const paths = resolvePaths();
  const store = new DataStore(paths);
  const bin = resolveMagpieBin(options);
  const handle = makeFetch(paths, store, bin);
  const requested = Number.isInteger(options.port) && options.port! >= 0 ? options.port! : 3498;
  for (;;) {
    try {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: requested,
        idleTimeout: 255,
        fetch: (request, srv) => {
          const port = srv.port ?? 0;
          const host = (request.headers.get("host") ?? "").toLowerCase();
          if (!ownHosts(port).has(host)) return failure(403, "host not allowed");
          const origin = request.headers.get("origin");
          if (!originAllowed(origin, port)) return failure(403, "origin not allowed");
          const pathname = new URL(request.url).pathname;
          if (!pathname.startsWith("/api/")) return handle(request);
          if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }), origin);
          if (!tokenOK(request)) return withCors(failure(403, "missing or wrong token"), origin);
          return handle(request).then(response => withCors(response, origin));
        },
      });
      const port = server.port ?? requested;
      if (options.log !== false) console.log(`pareto listening http://127.0.0.1:${port}`);
      return { server, port };
    } catch (error) {
      if (!options.retry) throw error;
      await Bun.sleep(200);
    }
  }
}

if (import.meta.main) {
  const raw = process.env.PARETO_PORT;
  const port = raw === undefined ? 3498 : Number(raw);
  await startService({ port: Number.isInteger(port) && port >= 0 ? port : 3498, log: true });
}
