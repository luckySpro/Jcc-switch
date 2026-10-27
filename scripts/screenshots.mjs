// 生成 docs/screenshots/ 下的一键贴 Key 与色卡截图。
// 用法：pnpm dev:renderer（另一个终端）后运行 node scripts/screenshots.mjs
import { createRequire } from "node:module";

// 用全局安装的 Playwright（项目不把它列为依赖）
const { chromium } = createRequire(import.meta.url)("playwright");
import { mkdirSync } from "node:fs";

const BASE = process.env.SCREENSHOT_BASE ?? "http://localhost:3000/dev/screenshots.html";
const OUT = "docs/screenshots";
const KEY = "sk-3f9c2a7e1b4d48e6a0c5f7d2e9b81a64";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();

async function shot(name, query, { width = 1000, height = 720, step } = {}) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(`${BASE}?${query}`);
  await page.waitForSelector("#quick-add-text, [role=radiogroup]");
  if (step === "confirm" || step === "probe" || step === "done") {
    await page.fill("#quick-add-text", KEY);
    await page.getByRole("button", { name: /识别并检测/ }).click();
    if (step === "probe") {
      await page.waitForTimeout(600);
    } else {
      await page.getByText("确认模型", { exact: false }).first().waitFor();
      await page.waitForSelector("text=api.deepseek.com/anthropic");
    }
    if (step === "done") {
      await page.getByRole("button", { name: /保存并启用/ }).click();
      await page.waitForSelector("text=已写入");
    }
  } else if (step === "paste") {
    await page.fill("#quick-add-text", KEY);
    await page.waitForSelector("text=api.deepseek.com");
  }
  await page.waitForTimeout(250);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (overflow) console.warn(`${name}: page overflows horizontally`);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  await page.close();
}

await shot("quick-add-paste", "swatch=clay", { step: "paste" });
await shot("quick-add-probe", "swatch=clay&hold=1", { step: "probe" });
await shot("quick-add-confirm", "swatch=clay", { step: "confirm" });
await shot("quick-add-confirm-dark", "swatch=clay&dark=1", { step: "confirm" });
await shot("quick-add-done", "swatch=clay", { step: "done" });
await shot("quick-add-narrow", "swatch=celadon", { step: "confirm", width: 420, height: 860 });
for (const s of ["graphite", "celadon", "indigo", "rose"]) {
  await shot(`swatch-${s}`, `swatch=${s}`, { step: "confirm", width: 900, height: 640 });
}
await shot("settings-swatches", "swatch=clay&view=settings", { width: 900, height: 300 });
await browser.close();
console.log("screenshots written to", OUT);
