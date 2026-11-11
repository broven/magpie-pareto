import { magpieEnv } from "./config";

export interface ServiceOptions {
  port?: number;
  magpieBin?: string;
  retry?: boolean;
  log?: boolean;
}

export function resolveMagpieBin(options: ServiceOptions = {}): string {
  if (options.magpieBin) return options.magpieBin;
  const found = Bun.which("magpie");
  return found || "/Applications/magpie.app/Contents/MacOS/magpie";
}

export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=+,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export function commandLine(args: string[]): string {
  return ["magpie", ...args.map(shellQuote)].join(" ");
}

export interface CommandResult {
  command: string;
  code: number;
  stdout: string;
  stderr: string;
}

export function cliEnv(): Record<string, string> {
  return { ...(process.env as Record<string, string>), ...magpieEnv() };
}

export async function runMagpie(bin: string, args: string[]): Promise<CommandResult> {
  const command = commandLine(args);
  try {
    const proc = Bun.spawn([bin, ...args], { env: cliEnv(), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { command, code, stdout, stderr };
  } catch (error: any) {
    return { command, code: -1, stdout: "", stderr: error?.message ?? String(error) };
  }
}
