import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function nowIso(): string {
  return new Date().toISOString();
}

export function isStale(iso: string | undefined, hours = 24): boolean {
  if (!iso) return true;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return true;
  return Date.now() - time > hours * 3600_000;
}

export async function readText(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); } catch { return null; }
}

export async function readJson<T>(path: string): Promise<T | null> {
  const text = await readText(path);
  if (text == null) return null;
  try { return JSON.parse(text) as T; } catch { return null; }
}

export async function atomicWrite(path: string, text: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await writeFile(tmp, text, { mode });
  await rename(tmp, path);
}

export async function atomicWriteJson(path: string, value: unknown, mode = 0o600): Promise<void> {
  await atomicWrite(path, JSON.stringify(value, null, 2) + "\n", mode);
}

export async function sha256File(path: string): Promise<string | null> {
  try {
    const data = await readFile(path);
    return createHash("sha256").update(data).digest("hex");
  } catch { return null; }
}

export async function fetchText(urlOrPath: string): Promise<string> {
  if (/^https?:\/\//i.test(urlOrPath)) {
    const response = await fetch(urlOrPath, { redirect: "follow" });
    if (!response.ok) throw new Error(`GET ${urlOrPath}: HTTP ${response.status}`);
    return await response.text();
  }
  const path = urlOrPath.startsWith("file://") ? decodeURIComponent(new URL(urlOrPath).pathname) : urlOrPath;
  return await readFile(path, "utf8");
}

export async function fetchBytes(urlOrPath: string): Promise<Buffer> {
  if (/^https?:\/\//i.test(urlOrPath)) {
    const response = await fetch(urlOrPath, { redirect: "follow" });
    if (!response.ok) throw new Error(`GET ${urlOrPath}: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  const path = urlOrPath.startsWith("file://") ? decodeURIComponent(new URL(urlOrPath).pathname) : urlOrPath;
  return await readFile(path);
}

export function round(value: number, digits = 6): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function fmtNum(value: number, digits = 4): string {
  if (!Number.isFinite(value)) return "—";
  const fixed = value.toFixed(digits);
  return fixed.replace(/\.?0+$/, "") || "0";
}

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
