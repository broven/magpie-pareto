// The service takes a token of its own on /api (see src/server.ts), and is
// asked by relative address so it works behind magpie web's proxy path.
const API_TOKEN = document.querySelector('meta[name="pareto-token"]')?.content ?? "";
const NS = "http://www.w3.org/2000/svg";
const PALETTE = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#7aa2f7", "#e6b84c", "#6cc99a"];
const MATCH_LABEL = { manual: "人工", fuzzy: "模糊", llm: "AI 猜测" };

const state = {
  chart: null,
  view: { board: "aa_intelligence_index", profile: "all", scale: "log", group: "", allOld: false },
  subscription: null,
  pendingPreview: null,
  selected: null,
  colors: new Map(),
};

const $ = (selector, root = document) => root.querySelector(selector);

function api(path, options = {}) {
  const init = { ...options, headers: { ...(options.headers || {}), "x-pareto-token": API_TOKEN } };
  if (init.body && typeof init.body !== "string") {
    init.body = JSON.stringify(init.body);
    init.headers["content-type"] = "application/json";
  }
  return fetch(path.replace(/^\//, ""), init).then(async response => {
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try { const body = await response.json(); if (body?.error) message = body.error; } catch { /* not JSON */ }
      throw new Error(message);
    }
    return response.json();
  });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgEl(tag, attrs = {}, text) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmt(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  const fixed = n.toFixed(digits);
  return fixed.replace(/\.?0+$/, "");
}

function fmtDate(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function colorFor(modelKey) {
  if (!state.colors.has(modelKey)) {
    state.colors.set(modelKey, PALETTE[state.colors.size % PALETTE.length]);
  }
  return state.colors.get(modelKey);
}

function setStatus(selector, text, kind) {
  const node = $(selector);
  if (!node) return;
  node.textContent = text;
  node.classList.toggle("bad", kind === "bad");
  node.classList.toggle("good", kind === "good");
}

// ---- chart ----------------------------------------------------------------

function renderChart(data) {
  const svg = $("#chart");
  svg.replaceChildren();
  state.colors = new Map();
  const W = 1000, H = 560;
  const left = 72, right = 26, top = 28, bottom = 86, freeWidth = 64;
  const plotLeft = left + freeWidth, plotRight = W - right, plotTop = top, plotBottom = H - bottom;
  const freeX = left + freeWidth / 2;
  const points = data.points ?? [];
  const officials = data.officialPoints ?? [];
  const scored = [...points, ...officials].filter(point => Number.isFinite(point.score));
  let yMin = scored.length ? Math.min(...scored.map(point => point.score)) : 0;
  let yMax = scored.length ? Math.max(...scored.map(point => point.score)) : 100;
  if (yMax === yMin) { yMax += 1; yMin = Math.max(0, yMin - 1); }
  const yPad = (yMax - yMin) * 0.1;
  yMin -= yPad; yMax += yPad;
  const priced = [...points, ...officials].filter(point => !point.free && point.price.blended > 0).map(point => point.price.blended);
  let xMin = 0.01, xMax = 100;
  if (priced.length) {
    xMin = Math.min(...priced); xMax = Math.max(...priced);
    if (xMin === xMax) { xMin /= 2; xMax *= 2; }
    if (data.scale === "linear") xMin = 0;
  }
  if (data.scale === "linear" && xMax <= 0) xMax = 1;
  const x = value => data.scale === "linear"
    ? plotLeft + ((value - xMin) / (xMax - xMin)) * (plotRight - plotLeft)
    : plotLeft + ((Math.log10(value) - Math.log10(xMin)) / (Math.log10(xMax) - Math.log10(xMin))) * (plotRight - plotLeft);
  const y = score => plotBottom - ((score - yMin) / (yMax - yMin)) * (plotBottom - plotTop);

  // Free column background and separator.
  svg.append(svgEl("rect", { x: left, y: plotTop, width: freeWidth - 6, height: plotBottom - plotTop, fill: "currentColor", "fill-opacity": 0.04, rx: 6 }));
  svg.append(svgEl("text", { x: freeX, y: plotTop - 8, "text-anchor": "middle", class: "free-title" }, "免费"));
  svg.append(svgEl("line", { x1: plotLeft - 6, y1: plotTop, x2: plotLeft - 6, y2: plotBottom, class: "free-sep" }));

  // Y grid and ticks.
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const value = yMin + ((yMax - yMin) * i) / yTicks;
    const yy = y(value);
    svg.append(svgEl("line", { x1: plotLeft, y1: yy, x2: plotRight, y2: yy, class: "grid" }));
    svg.append(svgEl("text", { x: plotLeft - 10, y: yy + 4, "text-anchor": "end" }, fmt(value, Math.abs(value) >= 100 ? 0 : 1)));
  }

  // X grid and ticks.
  if (data.scale === "linear") {
    for (let i = 0; i <= 4; i++) {
      const value = xMin + ((xMax - xMin) * i) / 4;
      const xx = x(value);
      svg.append(svgEl("line", { x1: xx, y1: plotTop, x2: xx, y2: plotBottom, class: "grid" }));
      svg.append(svgEl("text", { x: xx, y: plotBottom + 18, "text-anchor": "middle" }, `$${fmt(value, 3)}`));
    }
  } else {
    const ticks = [];
    const start = Math.floor(Math.log10(xMin));
    const end = Math.ceil(Math.log10(xMax));
    for (let power = start; power <= end; power++) {
      for (const multiplier of [1, 2, 5]) {
        const value = multiplier * 10 ** power;
        if (value >= xMin * 0.999 && value <= xMax * 1.001) ticks.push(value);
      }
    }
    const step = Math.max(1, Math.ceil(ticks.length / 8));
    for (let index = 0; index < ticks.length; index += step) {
      const value = ticks[index];
      const xx = x(value);
      if (xx < plotLeft - 1 || xx > plotRight + 1) continue;
      svg.append(svgEl("line", { x1: xx, y1: plotTop, x2: xx, y2: plotBottom, class: "grid" }));
      svg.append(svgEl("text", { x: xx, y: plotBottom + 18, "text-anchor": "middle" }, `$${fmt(value, value < 1 ? 3 : 2)}`));
    }
  }
  svg.append(svgEl("text", { x: (plotLeft + plotRight) / 2, y: H - 24, "text-anchor": "middle", class: "axis-title" },
    `合成价 USD / MTok（${data.scale === "linear" ? "线性" : "对数"}）`));
  svg.append(svgEl("text", { x: 18, y: (plotTop + plotBottom) / 2, "text-anchor": "middle", class: "axis-title", transform: `rotate(-90 18 ${(plotTop + plotBottom) / 2})` },
    data.board ? `${data.board.name} · ${data.board.metric}` : "能力分"));

  // Links first, under the points.
  for (const link of data.links ?? []) {
    const color = colorFor(link.modelKey);
    if (link.kind === "horizontal") {
      const list = [...link.points].sort((a, b) => a.price - b.price);
      for (let i = 1; i < list.length; i++) {
        const a = list[i - 1], b = list[i];
        const ax = a.price > 0 ? x(a.price) : freeX;
        const bx = b.price > 0 ? x(b.price) : freeX;
        svg.append(svgEl("line", { x1: ax, y1: y(a.score), x2: bx, y2: y(b.score), stroke: color, class: "link-h" }));
      }
    } else {
      const list = [...link.points].sort((a, b) => a.score - b.score);
      for (let i = 1; i < list.length; i++) {
        const a = list[i - 1], b = list[i];
        const xx = a.price > 0 ? x(a.price) : freeX;
        svg.append(svgEl("line", { x1: xx, y1: y(a.score), x2: xx, y2: y(b.score), stroke: color, class: "link-v" }));
      }
    }
  }

  const drawPoint = (point, official) => {
    const color = colorFor(point.modelKey);
    const px = point.free ? freeX : x(point.price.blended);
    const py = y(point.score);
    const circle = svgEl("circle", {
      cx: px, cy: py, r: official ? 5.5 : 6.5,
      fill: official ? "none" : color,
      "fill-opacity": official ? 0 : 0.92,
      stroke: color,
      "stroke-width": official ? 2 : 1.6,
      class: `point${official ? " official" : ""}`,
      "data-id": point.id,
      "data-model-key": point.modelKey,
    });
    if (point.suspect && !official) circle.setAttribute("stroke-dasharray", "3 2");
    circle.addEventListener("mouseenter", event => {
      highlight(point.modelKey);
      showTooltip(event, point, official);
    });
    circle.addEventListener("mousemove", event => positionTooltip(event));
    circle.addEventListener("mouseleave", () => {
      highlight(null);
      $("#tooltip").hidden = true;
    });
    circle.addEventListener("click", event => {
      event.stopPropagation();
      if (!official) selectPoint(point);
    });
    svg.append(circle);
    if (point.oldGen) {
      svg.append(svgEl("text", { x: px + 9, y: py - 8, class: "old-label", fill: color }, "旧代"));
    }
    if (point.manual) {
      svg.append(svgEl("text", { x: px + 9, y: py + 15, class: "manual-label", fill: color }, "手动"));
    }
    if (point.groups?.length && !official) {
      svg.append(svgEl("text", { x: px + 9, y: py + (point.manual ? 26 : 14), class: "group-label" }, point.groups.join("/")));
    }
  };

  for (const point of points) drawPoint(point, false);
  for (const point of officials) drawPoint(point, true);
}

function highlight(modelKey) {
  const svg = $("#chart");
  for (const node of svg.querySelectorAll(".point")) {
    const match = node.getAttribute("data-model-key") === modelKey;
    node.classList.toggle("dim", modelKey != null && !match);
    node.classList.toggle("hl", modelKey != null && match);
  }
}

function tooltipRows(point, official) {
  const rows = [
    ["渠道", official ? "官方价参照" : point.provider],
    ["模型", point.model],
    ...(point.matchedModel && point.matchedModel !== point.model ? [["榜单模型", point.matchedModel]] : []),
    ["effort", point.effort],
    ["harness", point.harness || "—"],
    ["input", `$${fmt(point.price.input)} / MTok`],
    ["output", `$${fmt(point.price.output)} / MTok`],
    ["cache read", `$${fmt(point.price.cache_read)} / MTok`],
    ["cache write", `$${fmt(point.price.cache_write)} / MTok`],
    ["合成价", `$${fmt(point.price.blended)} / MTok`],
    ["分数", `${fmt(point.score, 2)}（${point.scoreSource}）`],
    ["匹配", point.match ? `${MATCH_LABEL[point.match.kind] ?? point.match.kind}${point.match.confirmed ? "" : " · 未确认"}` : "—"],
  ];
  if (point.suspect) rows.push(["存疑", `系数 ${fmt(point.suspectFactor, 3)}`]);
  if (point.oldGen) rows.push(["代际", "旧代"]);
  if (point.groups?.length) rows.push(["路由组", point.groups.join(", ")]);
  if (point.manual) rows.push(["来源", "手动打分"]);
  return rows;
}

function showTooltip(event, point, official) {
  const box = $("#tooltip");
  box.replaceChildren();
  const title = el("div");
  const dot = el("span");
  dot.style.cssText = `display:inline-block;width:9px;height:9px;border-radius:50%;background:${colorFor(point.modelKey)};margin-right:6px`;
  title.append(dot, el("b", "", `${point.model} · ${point.effort}`));
  box.append(title);
  const table = el("table");
  for (const [label, value] of tooltipRows(point, official)) {
    const tr = el("tr");
    tr.append(el("td", "", label), el("td", "", value));
    table.append(tr);
  }
  box.append(table);
  box.hidden = false;
  positionTooltip(event);
}

function positionTooltip(event) {
  const box = $("#tooltip");
  if (box.hidden) return;
  const margin = 14;
  const rect = box.getBoundingClientRect();
  let left = event.clientX + margin;
  let top = event.clientY + margin;
  if (left + rect.width > window.innerWidth - 8) left = event.clientX - rect.width - margin;
  if (top + rect.height > window.innerHeight - 8) top = event.clientY - rect.height - margin;
  box.style.left = `${Math.max(8, left)}px`;
  box.style.top = `${Math.max(8, top)}px`;
}

// ---- no-score band --------------------------------------------------------

function renderNoScore(data) {
  const list = $("#no-score-list");
  list.replaceChildren();
  if (!data.noScore?.length) {
    list.append(el("span", "muted", "没有。"));
    return;
  }
  for (const item of data.noScore) {
    const node = el("button", "no-score-item", `${item.provider}/${item.model} · $${fmt(item.price.blended)}`);
    node.type = "button";
    node.addEventListener("click", () => selectNoScore(item));
    list.append(node);
  }
}

// ---- point actions --------------------------------------------------------

function selectPoint(point) {
  state.selected = { kind: "point", point };
  renderPointActions();
}

function selectNoScore(item) {
  state.selected = { kind: "noScore", item };
  renderPointActions();
}

function renderPointActions() {
  const panel = $("#point-actions");
  const menu = $("#point-menu");
  menu.replaceChildren();
  if (!state.selected) { panel.hidden = true; return; }
  panel.hidden = false;
  const target = state.selected.kind === "point" ? state.selected.point : state.selected.item;
  $("#point-title").textContent = `${target.provider}/${target.model}${target.effort ? ` · ${target.effort}` : ""}`;

  const info = el("p", "muted");
  if (state.selected.kind === "point") {
    info.textContent = `合成价 $${fmt(target.price.blended)} / MTok · 分数 ${fmt(target.score, 2)} · ${MATCH_LABEL[target.match?.kind] ?? "—"}`;
  } else {
    info.textContent = `有价格 $${fmt(target.price.blended)} / MTok，当前榜单没有分。`;
  }
  menu.append(info);

  if (state.selected.kind === "noScore") {
    const section = el("div", "section");
    section.append(el("b", "", "手动打分"));
    const input = el("input");
    input.type = "number";
    input.step = "0.1";
    input.placeholder = "当前榜单分数";
    input.id = "manual-score";
    input.dataset.testid = "manual-score";
    const save = el("button", "", "保存");
    save.type = "button";
    save.dataset.testid = "manual-save";
    save.addEventListener("click", async () => {
      try {
        await api("/api/state/manual-score", {
          method: "POST",
          body: {
            board: state.view.board,
            provider: target.provider,
            model: target.model,
            score: input.value === "" ? null : Number(input.value),
          },
        });
        state.selected = null;
        await loadChart();
      } catch (error) { setStatus("#warnings", `打分失败：${error.message}`, "bad"); }
    });
    section.append(input, save);
    menu.append(section);
  }

  const suspectSection = el("div", "section");
  suspectSection.append(el("b", "", "存疑"));
  const suspectBox = el("input");
  suspectBox.type = "checkbox";
  suspectBox.checked = !!target.suspect;
  const factor = el("input");
  factor.type = "number";
  factor.step = "0.05";
  factor.min = "0.05";
  factor.value = target.suspectFactor && target.suspectFactor !== 1 ? target.suspectFactor : "";
  factor.placeholder = "系数（可选）";
  const suspectSave = el("button", "", "保存");
  suspectSave.type = "button";
  suspectSave.dataset.testid = "suspect-save";
  suspectSave.addEventListener("click", async () => {
    try {
      await api("/api/state/suspect", {
        method: "POST",
        body: { provider: target.provider, model: target.model, suspect: suspectBox.checked, factor: factor.value === "" ? 1 : Number(factor.value) },
      });
      await loadChart();
    } catch (error) { setStatus("#warnings", `存疑设置失败：${error.message}`, "bad"); }
  });
  suspectSection.append(suspectBox, el("span", "muted", "分数 ×"), factor, suspectSave);
  menu.append(suspectSection);

  const seriesSection = el("div", "section");
  seriesSection.append(el("b", "", "系列"));
  const seriesInput = el("input");
  seriesInput.type = "text";
  seriesInput.placeholder = "自定义系列键";
  seriesInput.value = target.series ?? "";
  seriesInput.dataset.testid = "series-input";
  const seriesSave = el("button", "", "保存");
  seriesSave.type = "button";
  seriesSave.addEventListener("click", async () => {
    try {
      await api("/api/state/series", { method: "POST", body: { model: target.model, series: seriesInput.value } });
      await loadChart();
    } catch (error) { setStatus("#warnings", `系列设置失败：${error.message}`, "bad"); }
  });
  seriesSection.append(seriesInput, seriesSave);
  menu.append(seriesSection);

  if (state.selected.kind === "point") {
    const groupSection = el("div", "section");
    groupSection.append(el("b", "", "路由组"));
    const select = el("select");
    select.dataset.testid = "action-group";
    for (const group of state.chart?.groups ?? []) {
      const option = el("option", "", `${group.name}（${group.id}）`);
      option.value = group.id;
      select.append(option);
    }
    const mode = el("select");
    mode.dataset.testid = "action-mode";
    const replace = el("option", "", "替换为唯一成员");
    replace.value = "replace";
    const append = el("option", "", "追加到末尾");
    append.value = "append";
    mode.append(replace, append);
    const preview = el("button", "", "预览命令");
    preview.type = "button";
    preview.dataset.testid = "group-preview";
    const apply = el("button", "", "确认执行");
    apply.type = "button";
    apply.dataset.testid = "group-apply";
    apply.disabled = true;
    const status = el("p", "muted");
    const output = el("pre", "commands");
    output.hidden = true;
    let pending = null;
    preview.addEventListener("click", async () => {
      try {
        pending = await api("/api/group/preview", {
          method: "POST",
          body: { group: select.value, provider: target.provider, model: target.model, mode: mode.value },
        });
        output.hidden = false;
        output.textContent = `${pending.command}\n\n之前：${pending.before.join(", ") || "（空）"}\n之后：${pending.after.join(", ") || "（空）"}`;
        apply.disabled = false;
        status.textContent = "";
      } catch (error) { status.textContent = `预览失败：${error.message}`; status.className = "bad"; }
    });
    apply.addEventListener("click", async () => {
      if (!pending) return;
      if (!window.confirm(`执行 ${pending.command}？`)) return;
      try {
        const result = await api("/api/group/apply", {
          method: "POST",
          body: { group: select.value, provider: target.provider, model: target.model, mode: mode.value, dryRun: false },
        });
        output.textContent = `${pending.command}\n\n读回：\n${result.readBack}`;
        status.textContent = result.ok ? "已写回。" : `写回失败：${result.error}`;
        status.className = result.ok ? "good" : "bad";
        await loadChart();
      } catch (error) { status.textContent = `写回失败：${error.message}`; status.className = "bad"; }
    });
    groupSection.append(select, mode, preview, apply);
    menu.append(groupSection, status, output);
  }
}

// ---- chart load -----------------------------------------------------------

function readViewFromControls() {
  state.view.board = $("#board-select").value || state.view.board;
  state.view.profile = $("#profile-select").value || state.view.profile;
  state.view.scale = $("#scale-select").value;
  state.view.group = $("#group-filter").value;
  state.view.allOld = $("#show-old").checked;
}

function fillSelect(select, items, value, labeler = item => item.label ?? item.id) {
  select.replaceChildren();
  for (const item of items) {
    const option = el("option", "", labeler(item));
    option.value = item.id ?? item;
    select.append(option);
  }
  if (value !== undefined && [...select.options].some(option => option.value === value)) select.value = value;
}

async function loadChart() {
  const query = new URLSearchParams();
  if (state.view.board) query.set("board", state.view.board);
  if (state.view.profile) query.set("profile", state.view.profile);
  query.set("scale", state.view.scale);
  if (state.view.group) query.set("group", state.view.group);
  if (state.view.allOld) query.set("allOld", "1");
  try {
    const data = await api(`/api/chart?${query.toString()}`);
    state.chart = data;
    if (data.board) state.view.board = data.board.id;
    state.view.profile = data.profile.id;
    fillSelect($("#board-select"), data.boards.map(board => ({ id: board.id, label: `${board.name}（${board.snapshot}）` })), state.view.board);
    fillSelect($("#profile-select"), data.profiles, state.view.profile);
    fillSelect($("#group-filter"), [{ id: "", label: "全部" }, ...data.groups.map(group => ({ id: group.id, label: `${group.name}（${group.id}）` }))], state.view.group);
    $("#show-old").checked = state.view.allOld;
    $("#scale-select").value = state.view.scale;
    $("#board-meta").textContent = data.board
      ? `${data.board.name} · 快照 ${data.board.snapshot} · ${data.points.length} 个点 · 画像 ${data.profile.label}`
      : "没有榜单数据";
    const dates = data.cacheDates ?? {};
    $("#cache-dates").textContent = `缓存：models.dev ${fmtDate(dates.models)} · RAP ${fmtDate(dates.rap)} · Epoch ${fmtDate(dates.epoch)} · 网关 ${fmtDate(dates.gateway)}`;
    const warnings = data.warnings ?? [];
    $("#warnings").hidden = warnings.length === 0;
    $("#warnings").textContent = warnings.join("；");
    renderChart(data);
    renderNoScore(data);
    renderLegend(data);
    renderLlmMatches(data);
    renderAttribution(data);
    if (state.selected) {
      const key = state.selected.kind === "point" ? state.selected.point.id : null;
      const still = key ? data.points.find(point => point.id === key) : null;
      if (!still) { state.selected = null; renderPointActions(); }
    }
    await loadSubscription();
  } catch (error) {
    $("#warnings").hidden = false;
    $("#warnings").textContent = `加载失败：${error.message}`;
  }
}

function renderLegend(data) {
  const legend = $("#legend");
  legend.replaceChildren();
  const seen = new Map();
  for (const point of data.points) if (!seen.has(point.modelKey)) seen.set(point.modelKey, point.matchedModel ?? point.model);
  for (const [modelKey, model] of [...seen.entries()].slice(0, 14)) {
    const item = el("span", "item");
    const swatch = el("span", "swatch");
    swatch.style.background = colorFor(modelKey);
    item.append(swatch, el("span", "", model));
    legend.append(item);
  }
}

function renderLlmMatches(data) {
  const box = $("#llm-matches");
  box.replaceChildren();
  const guesses = new Map();
  for (const point of data.points) {
    if (point.match?.kind === "llm") guesses.set(`${point.provider}/${point.model}`, point);
  }
  if (!guesses.size) return;
  box.append(el("h3", "", "AI 猜测"));
  for (const [key, point] of guesses) {
    const row = el("div", "match-row");
    row.append(el("code", "", `${key} → ${point.model}`));
    const confirm = el("button", "", "确认");
    confirm.type = "button";
    confirm.dataset.testid = "match-confirm";
    confirm.addEventListener("click", async () => {
      await api("/api/state/match", { method: "POST", body: { provider: point.provider, model: point.model, board: state.view.board, action: "confirm" } });
      await loadChart();
    });
    const reject = el("button", "", "驳回");
    reject.type = "button";
    reject.dataset.testid = "match-reject";
    reject.addEventListener("click", async () => {
      await api("/api/state/match", { method: "POST", body: { provider: point.provider, model: point.model, board: state.view.board, action: "reject" } });
      await loadChart();
    });
    row.append(confirm, reject);
    box.append(row);
  }
}

function renderAttribution(data) {
  const dates = data.cacheDates ?? {};
  const rapSnapshot = data.boards.filter(board => board.source === "rap").map(board => board.snapshot).filter(Boolean).sort().at(-1) ?? "—";
  const epochSnapshot = data.boards.find(board => board.source === "epoch")?.snapshot ?? "—";
  $("#attribution").textContent = [
    `real-api-pricing（MIT）快照 ${rapSnapshot} · 缓存 ${fmtDate(dates.rap)}`,
    `Artificial Analysis（AA 系列榜单）快照 ${rapSnapshot}`,
    `Epoch AI（CC-BY 4.0）快照 ${epochSnapshot} · 缓存 ${fmtDate(dates.epoch)}`,
    `models.dev 缓存 ${fmtDate(dates.models)}`,
  ].join(" · ");
}

// ---- subscription ---------------------------------------------------------

function subValue(id) {
  const node = document.getElementById(id);
  return node && node.value !== "" ? Number(node.value) : undefined;
}

function currentSubscriptionInputs() {
  const mode = $("#sub-mode").value;
  const subscription = { mode };
  const feeUsd = subValue("sub-fee-usd");
  const feeCny = subValue("sub-fee-cny");
  const rate = subValue("sub-rate");
  if (feeCny !== undefined) { subscription.feeCny = feeCny; if (rate !== undefined) subscription.rate = rate; }
  else if (feeUsd !== undefined) subscription.feeUsd = feeUsd;
  if (mode === "usd") subscription.quotaUsd = subValue("sub-quota");
  else if (mode === "tokens") subscription.tokens = subValue("sub-tokens");
  else if (mode === "requests") { subscription.windowHours = subValue("sub-window"); subscription.requests = subValue("sub-requests"); }
  else if (mode === "credits") {
    subscription.quotaUsd = subValue("sub-quota");
    const multipliers = {};
    for (const line of String($("#sub-multipliers")?.value ?? "").split("\n")) {
      const [model, value] = line.split("=").map(part => part.trim());
      if (model && Number(value) > 0) multipliers[model] = Number(value);
    }
    subscription.multipliers = multipliers;
  }
  return subscription;
}

function renderSubInputs() {
  const box = $("#sub-inputs");
  box.replaceChildren();
  if (!state.subscription) return;
  const provider = $("#sub-provider").value;
  const saved = state.subscription.subscriptions?.[provider] ?? {};
  const mode = $("#sub-mode").value;
  const add = (label, id, value, type = "number", extra = {}) => {
    const wrap = el("label", "", label);
    const input = el("input");
    input.id = id;
    input.type = type;
    if (value !== undefined && value !== null) input.value = String(value);
    Object.assign(input, extra);
    wrap.append(input);
    box.append(wrap);
  };
  add("月费 USD", "sub-fee-usd", saved.feeUsd);
  add("月费 CNY", "sub-fee-cny", saved.feeCny);
  add("汇率（CNY/USD）", "sub-rate", saved.rate);
  if (mode === "usd") add("额度等值美元", "sub-quota", saved.quotaUsd);
  else if (mode === "tokens") add("每月 token", "sub-tokens", saved.tokens);
  else if (mode === "requests") {
    add("时间窗（小时）", "sub-window", saved.windowHours);
    add("每窗请求数", "sub-requests", saved.requests);
  } else if (mode === "credits") {
    add("1× 额度等值美元", "sub-quota", saved.quotaUsd);
    const wrap = el("label", "", "每模型倍率（model=倍率，每行一条）");
    const area = el("textarea");
    area.id = "sub-multipliers";
    const multipliers = saved.multipliers ?? {};
    area.value = Object.entries(multipliers).map(([model, value]) => `${model}=${value}`).join("\n");
    wrap.append(area);
    box.append(wrap);
  }
}

function renderPlanSelect() {
  const select = $("#plan-select");
  const prefix = $("#plan-prefix").value.trim();
  const plans = (state.subscription?.plans ?? []).filter(plan => !prefix || plan.id.startsWith(prefix));
  select.replaceChildren();
  const none = el("option", "", "不使用套餐");
  none.value = "";
  select.append(none);
  for (const plan of plans) {
    const option = el("option", "", `${plan.id}（${plan.label}）`);
    option.value = plan.id;
    select.append(option);
  }
  renderScenarioSelect();
}

function renderScenarioSelect() {
  const select = $("#plan-scenario");
  select.replaceChildren();
  const plan = (state.subscription?.plans ?? []).find(item => item.id === $("#plan-select").value);
  if (!plan) return;
  for (const scenario of plan.scenarios) {
    const option = el("option", "", scenario);
    option.value = scenario;
    select.append(option);
  }
  if (plan.defaultScenario) select.value = plan.defaultScenario;
}

async function loadSubscription() {
  try {
    const data = await api(`/api/subscription?profile=${encodeURIComponent(state.view.profile)}`);
    state.subscription = data;
    const providerSelect = $("#sub-provider");
    const current = providerSelect.value;
    fillSelect(providerSelect, data.providers.map(provider => ({ id: provider.id, label: provider.id })), current);
    renderSubInputs();
    renderPlanSelect();
  } catch (error) {
    setStatus("#sub-status", `订阅数据加载失败：${error.message}`, "bad");
  }
}

function renderPreview(preview) {
  const box = $("#sub-diff");
  box.replaceChildren();
  const warnings = $("#sub-warnings");
  warnings.hidden = !preview.warnings?.length;
  warnings.textContent = (preview.warnings ?? []).join("；");
  if (!preview.rows?.length) {
    box.append(el("p", "muted", "没有可预览的行。"));
    return;
  }
  const table = el("table");
  const head = el("tr");
  for (const label of ["模型", "折扣率", "额度等值 USD", "旧 input", "旧 output", "旧 cache read", "旧 cache write", "新 input", "新 output", "新 cache read", "新 cache write"]) {
    head.append(el("th", "", label));
  }
  table.append(head);
  for (const row of preview.rows) {
    const tr = el("tr");
    tr.append(
      el("td", "", row.model),
      el("td", "", fmt(row.discount, 6)),
      el("td", "", fmt(row.quotaUsd, 2)),
      el("td", "", fmt(row.old.input)),
      el("td", "", fmt(row.old.output)),
      el("td", "", fmt(row.old.cache_read)),
      el("td", "", fmt(row.old.cache_write)),
      el("td", "", fmt(row.next.input)),
      el("td", "", fmt(row.next.output)),
      el("td", "", fmt(row.next.cache_read)),
      el("td", "", fmt(row.next.cache_write)),
    );
    table.append(tr);
  }
  box.append(table);
  const commands = $("#sub-commands");
  commands.hidden = false;
  commands.textContent = preview.commands.join("\n");
  $("#sub-apply").disabled = false;
}

async function previewSubscription() {
  const provider = $("#sub-provider").value;
  if (!provider) return;
  const subscription = currentSubscriptionInputs();
  const planId = $("#plan-select").value;
  const plan = planId ? { id: planId, scenario: $("#plan-scenario").value } : undefined;
  try {
    await api("/api/state/subscription", { method: "POST", body: { provider, subscription, plan } });
    const preview = await api("/api/subscription/preview", {
      method: "POST",
      body: { provider, profile: state.view.profile, subscription, plan },
    });
    state.pendingPreview = { provider, subscription, plan };
    renderPreview(preview);
    setStatus("#sub-status", `已预览 ${preview.rows.length} 个模型。`, "good");
  } catch (error) {
    setStatus("#sub-status", `预览失败：${error.message}`, "bad");
    $("#sub-apply").disabled = true;
  }
}

async function applySubscription() {
  if (!state.pendingPreview) return;
  const { provider, subscription, plan } = state.pendingPreview;
  if (!window.confirm(`执行写回 ${provider}？会逐条调用 magpie model price。`)) return;
  try {
    const result = await api("/api/subscription/apply", {
      method: "POST",
      body: { provider, profile: state.view.profile, subscription, plan, dryRun: false },
    });
    const commands = $("#sub-commands");
    commands.hidden = false;
    commands.textContent = `${result.preview.commands.join("\n")}\n\n${result.executed.map(item => `$ ${item.command}\n${item.stdout}${item.stderr}`).join("\n")}`;
    setStatus("#sub-status", result.ok ? `已写回并读回核对 ${result.executed.length} 条命令。` : `写回失败：${result.error ?? "读回不一致"}`, result.ok ? "good" : "bad");
    await loadChart();
  } catch (error) {
    setStatus("#sub-status", `写回失败：${error.message}`, "bad");
  }
}

// ---- settings -------------------------------------------------------------

async function loadSettings() {
  try {
    const data = await api("/api/state");
    $("#llm-model").value = data.llmModel ?? "";
  } catch { /* the chart already reports service errors */ }
}

async function saveLlmModel() {
  try {
    await api("/api/state/llm", { method: "POST", body: { model: $("#llm-model").value } });
    setStatus("#settings-status", "已保存。", "good");
    await loadChart();
  } catch (error) {
    setStatus("#settings-status", `保存失败：${error.message}`, "bad");
  }
}

// ---- boot -----------------------------------------------------------------

$("#board-select").addEventListener("change", () => { readViewFromControls(); loadChart(); });
$("#profile-select").addEventListener("change", () => { readViewFromControls(); loadChart(); });
$("#scale-select").addEventListener("change", () => { readViewFromControls(); loadChart(); });
$("#group-filter").addEventListener("change", () => { readViewFromControls(); loadChart(); });
$("#show-old").addEventListener("change", () => { readViewFromControls(); loadChart(); });
$("#refresh-button").addEventListener("click", async () => {
  $("#refresh-button").disabled = true;
  try {
    const result = await api("/api/refresh", { method: "POST", body: {} });
    if (result.warnings?.length) {
      $("#warnings").hidden = false;
      $("#warnings").textContent = result.warnings.join("；");
    }
    await loadChart();
  } catch (error) {
    $("#warnings").hidden = false;
    $("#warnings").textContent = `刷新失败：${error.message}`;
  } finally {
    $("#refresh-button").disabled = false;
  }
});
$("#sub-provider").addEventListener("change", renderSubInputs);
$("#sub-mode").addEventListener("change", renderSubInputs);
$("#plan-prefix").addEventListener("input", renderPlanSelect);
$("#plan-select").addEventListener("change", renderScenarioSelect);
$("#sub-preview").addEventListener("click", previewSubscription);
$("#sub-apply").addEventListener("click", applySubscription);
$("#llm-save").addEventListener("click", saveLlmModel);

loadSettings();
loadChart();
