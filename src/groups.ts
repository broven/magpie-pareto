import { resolvePaths, type Paths } from "./config";
import { readGroups, type GroupInfo } from "./datasources";
import { resolveMagpieBin, runMagpie, type CommandResult } from "./magpie";

export interface GroupPreview {
  ok: boolean;
  group: string;
  provider: string;
  model: string;
  mode: "replace" | "append";
  before: string[];
  after: string[];
  command: string;
  error?: string;
}

function member(provider: string, model: string): string {
  return `${provider}/${model}`;
}

export function previewGroup(paths: Paths, groupId: string, provider: string, model: string, mode: "replace" | "append"): GroupPreview {
  const groups = readGroups(paths);
  const group: GroupInfo | undefined = groups.find(item => item.id === groupId);
  const target = member(provider, model);
  if (!group) {
    return { ok: false, group: groupId, provider, model, mode, before: [], after: [], command: "", error: `未知组 ${groupId}` };
  }
  const before = [...group.members];
  let after: string[];
  let command: string;
  if (mode === "replace") {
    after = [target];
    command = `magpie group set ${groupId} models=${after.join(",")}`;
  } else {
    after = before.includes(target) ? before : [...before, target];
    command = `magpie group set ${groupId} models+=${target}`;
  }
  return { ok: true, group: groupId, provider, model, mode, before, after, command };
}

export interface GroupApplyResult extends GroupPreview {
  executed: CommandResult[];
  readBack: string;
  error?: string;
}

export async function applyGroup(
  paths: Paths,
  groupId: string,
  provider: string,
  model: string,
  mode: "replace" | "append",
  dryRun: boolean,
  magpieBin?: string,
): Promise<GroupApplyResult> {
  const preview = previewGroup(paths, groupId, provider, model, mode);
  if (!preview.ok) return { ...preview, executed: [], readBack: "" };
  if (dryRun) return { ...preview, executed: [], readBack: "" };
  const bin = resolveMagpieBin({ magpieBin });
  const args = mode === "replace"
    ? ["group", "set", groupId, `models=${preview.after.join(",")}`]
    : ["group", "set", groupId, `models+=${member(provider, model)}`];
  const executed: CommandResult[] = [];
  const result = await runMagpie(bin, args);
  executed.push(result);
  if (result.code !== 0) {
    return { ...preview, ok: false, executed, readBack: "", error: `命令失败：${result.stderr.trim() || result.stdout.trim()}` };
  }
  const read = await runMagpie(bin, ["group", groupId]);
  executed.push(read);
  if (read.code !== 0) {
    return { ...preview, ok: false, executed, readBack: "", error: `读回失败：${read.stderr.trim() || read.stdout.trim()}` };
  }
  return { ...preview, executed, readBack: read.stdout };
}

export { resolvePaths };
