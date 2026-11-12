// Lab (vendor) identification for the chart's color scheme. The UI gives each
// lab one base hue (ui/app.js LAB_HUE) and its series nearby variants. The
// mapping works on the normalized model id (provider prefix stripped), so it
// does not depend on the channel a model happens to be sold through.
import { normalizeModelId } from "./normalize";

export interface Lab {
  id: string;
  name: string;
}

// Known labs, in legend order.
export const LABS: Lab[] = [
  { id: "anthropic", name: "Anthropic" },
  { id: "openai", name: "OpenAI" },
  { id: "google", name: "Google" },
  { id: "deepseek", name: "DeepSeek" },
  { id: "zhipu", name: "智谱" },
  { id: "moonshot", name: "Moonshot" },
  { id: "alibaba", name: "阿里" },
  { id: "minimax", name: "MiniMax" },
  { id: "xai", name: "xAI" },
  { id: "bytedance", name: "字节" },
  { id: "tencent", name: "腾讯" },
  { id: "xiaomi", name: "小米" },
  { id: "stepfun", name: "阶跃" },
  { id: "meituan", name: "美团" },
  { id: "nvidia", name: "NVIDIA" },
];

export const OTHER_LAB: Lab = { id: "other", name: "其他" };

const BY_ID = new Map([...LABS, OTHER_LAB].map(lab => [lab.id, lab]));

// Prefix -> lab. Checked in order against the normalized model id. "o\d" is
// OpenAI's o-series (o3, o4-mini) and "hy\d" is Tencent's Hunyuan shorthand
// (hy4free); both would otherwise fall through to 其他.
const PREFIXES: Array<[RegExp, string]> = [
  [/^claude(?:-|$)/, "anthropic"],
  [/^(?:gpt|codex)(?:-|$)/, "openai"],
  [/^o\d/, "openai"],
  [/^gemini(?:-|$)/, "google"],
  [/^deepseek(?:-|$)/, "deepseek"],
  [/^glm(?:\d|-|$)/, "zhipu"],
  [/^kimi(?:-|$)/, "moonshot"],
  [/^qwen(?:\d|-|$)/, "alibaba"],
  [/^minimax(?:-|$)/, "minimax"],
  [/^grok(?:-|$)/, "xai"],
  [/^(?:doubao|seed)(?:-|$)/, "bytedance"],
  [/^hy\d/, "tencent"],
  [/^hunyuan(?:-|$)/, "tencent"],
  [/^mimo(?:-|$)/, "xiaomi"],
  [/^step(?:\d|-|$)/, "stepfun"],
  [/^longcat(?:-|$)/, "meituan"],
  [/^nemotron(?:-|$)/, "nvidia"],
];

export function labForModel(id: string): Lab {
  const key = normalizeModelId(id);
  for (const [pattern, labId] of PREFIXES) {
    if (pattern.test(key)) return BY_ID.get(labId)!;
  }
  return OTHER_LAB;
}

export function labById(id: string): Lab {
  return BY_ID.get(id) ?? OTHER_LAB;
}
