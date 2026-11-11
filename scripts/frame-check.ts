// Loads the plugin the way magpie's window does: page/ in an iframe sandboxed
// to allow-scripts, served under magpie's page policy (pagePolicy in
// internal/gui/pluginpage.go), with a stand-in bridge. Passes only when the
// frame goes on to the service and the interface lists the boards from
// there, with an opaque origin. Catches an inline script the policy blocks
// and a service that refuses Origin "null".
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { root, startFixtureStack } from "./fixtures";
import { loadChromium } from "./playwright";

const chromium = await loadChromium();
const stack = await startFixtureStack();
const service = stack.base;
const servicePort = new URL(service).port;

const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".svg": "image/svg+xml" };
let window_: ReturnType<typeof Bun.serve> | undefined;
let browser: any;
let failed = false;
try {
  // magpie's window: its own page holding the plugin's frame, and the
  // frame's files under the page policy.
  window_ = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/") {
        return new Response(`<!doctype html><iframe id="f" sandbox="allow-scripts" style="width:1000px;height:800px" src="/plugin/index.html"></iframe>`, { headers: { "content-type": "text/html" } });
      }
      if (!path.startsWith("/plugin/")) return new Response("no", { status: 404 });
      const own = `http://${req.headers.get("host")}/plugin/`;
      const policy = [
        "sandbox allow-scripts", "default-src 'none'", `script-src ${own}`, `style-src ${own} 'unsafe-inline'`,
        `img-src ${own} data:`, `font-src ${own}`, `media-src ${own}`, "connect-src 'none'", "frame-src 'none'",
        "worker-src 'none'", "object-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'self'",
      ].join("; ");
      const rel = path.slice("/plugin/".length);
      let body: string | Blob;
      if (rel === "_magpie/bridge.js") {
        body = `window.magpie = { ready: Promise.resolve({ dark: false }), service: "", options: { get: async () => ({ port: ${servicePort} }) } };`;
      } else {
        const file = Bun.file(join(root, "page", rel));
        if (rel.includes("..") || !(await file.exists())) return new Response("no", { status: 404 });
        body = file;
      }
      return new Response(body, { headers: { "content-type": types[extname(rel)] ?? "application/octet-stream", "content-security-policy": policy } });
    },
  });

  browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() =>
    chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true }));
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("console", (message: any) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${window_.port}/`);

  const end = Date.now() + 20_000;
  let frame: any;
  let boards: string[] = [];
  while (Date.now() < end) {
    frame = page.frames().find((item: any) => item.url().startsWith(service));
    if (frame) {
      boards = await frame.$$eval("#board-select option", (options: any[]) => options.map(option => option.value)).catch(() => []);
      if (boards.length) break;
    }
    await Bun.sleep(200);
  }
  if (!frame) throw new Error(`the frame never went to the service; console errors: ${errors.join(" | ")}`);
  if (!boards.length) throw new Error(`the interface listed no boards in the sandboxed frame; console errors: ${errors.join(" | ")}`);
  const origin = await frame.evaluate(() => self.origin);
  if (origin !== "null") throw new Error(`frame origin is ${origin}, expected opaque "null"`);
  const points = await frame.$$eval("#chart .point", (nodes: any[]) => nodes.length);
  if (!points) throw new Error("the chart drew no points in the sandboxed frame");
  const framePage = await readFile(join(root, "page/index.html"), "utf8");
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(framePage)) throw new Error("page/index.html has an inline script");

  console.log(`PASS frame went to ${frame.url()} (origin ${origin}); boards: ${boards.join(", ")}; points: ${points}`);
} catch (error: any) {
  failed = true;
  console.error(`FAIL ${error?.message ?? error}`);
} finally {
  await browser?.close();
  window_?.stop(true);
  await stack.close();
  process.exit(failed ? 1 : 0);
}
