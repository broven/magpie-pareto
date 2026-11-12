import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { root, startFixtureStack } from "./fixtures";
import { loadChromium } from "./playwright";

const chromium = await loadChromium();

const artifactDir = join(root, "artifacts");
await mkdir(artifactDir, { recursive: true, mode: 0o700 });

async function launch() {
  try {
    return await chromium.launch({ channel: "chrome", headless: true });
  } catch {
    return await chromium.launch({
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
    });
  }
}

async function noHorizontalScroll(page: any, width: number) {
  const sizes = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
    body: document.body.scrollWidth,
  }));
  if (sizes.scroll > sizes.client || sizes.body > sizes.client) {
    throw new Error(`${width}px viewport has horizontal scroll: ${JSON.stringify(sizes)}`);
  }
  return sizes;
}

const stack = await startFixtureStack();
// Give the two free fixture points different quota multipliers so the free
// column's horizontal mini-axis is visible in the screenshots.
for (const [provider, multiplier] of [["chan-a", 0], ["grant-chan", 1.5]] as const) {
  const response = await fetch(stack.base + "/api/state/quota-multiplier", {
    method: "POST",
    headers: { "content-type": "application/json", "x-pareto-token": stack.token },
    body: JSON.stringify({ provider, model: "free-bee", multiplier }),
  });
  if (!response.ok) throw new Error(`quota multiplier setup failed: HTTP ${response.status}`);
}
let browser: any;
try {
  browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1180, height: 1000 }, colorScheme: "light" });
  await page.goto(stack.base + "/", { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelectorAll("#chart .point").length > 0, undefined, { timeout: 30_000 });
  await page.locator('#chart .point').first().hover();
  await page.waitForFunction(() => {
    const box = document.querySelector("#tooltip");
    return box && !box.hidden && (box.textContent ?? "").length > 0;
  }, undefined, { timeout: 5_000 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(artifactDir, "ui-1180.png"), fullPage: true });
  console.log("PASS ui-1180.png");

  await page.setViewportSize({ width: 420, height: 900 });
  const light420 = await noHorizontalScroll(page, 420);
  await page.screenshot({ path: join(artifactDir, "ui-420.png"), fullPage: true });
  console.log("PASS ui-420.png", JSON.stringify(light420));

  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1180, height: 1000 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(artifactDir, "ui-1180-dark.png"), fullPage: true });
  console.log("PASS ui-1180-dark.png");

  await page.setViewportSize({ width: 420, height: 900 });
  const dark420 = await noHorizontalScroll(page, 420);
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(artifactDir, "ui-420-dark.png"), fullPage: true });
  console.log("PASS ui-420-dark.png", JSON.stringify(dark420));

  console.log(`artifacts: ${["ui-1180.png", "ui-420.png", "ui-1180-dark.png", "ui-420-dark.png"].map(name => join(artifactDir, name)).join(", ")}`);
} finally {
  if (browser) await browser.close();
  await stack.close();
}
