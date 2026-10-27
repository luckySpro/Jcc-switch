/**
 * 开发用截图页：用演示数据渲染一键贴 Key 和色卡，不进生产构建。
 * pnpm dev:renderer 后打开 /dev/screenshots.html?swatch=clay&dark=0
 * scripts/screenshots.mjs 用 Playwright 逐个状态截图到 docs/screenshots/。
 */
import React from "react";
import ReactDOM from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "../index.css";
import i18n from "@/i18n";
import { applySwatch, type SwatchId } from "@/themes/swatches";
import { QuickAddDialog } from "@/components/quick-add/QuickAddDialog";
import { SwatchPicker } from "@/components/settings/SwatchPicker";
import { Button } from "@/components/ui/button";
import type { DetectResult, ProbeEvent } from "@/lib/api/quickAdd";

const params = new URLSearchParams(location.search);
void i18n.changeLanguage(params.get("lang") ?? "zh");
applySwatch((params.get("swatch") as SwatchId) ?? "clay");
document.documentElement.classList.toggle("dark", params.get("dark") === "1");
document.documentElement.classList.toggle("light", params.get("dark") !== "1");

const DEMO_KEY = "sk-3f9c2a7e1b4d48e6a0c5f7d2e9b81a64";
const candidates = [
  {
    id: "deepseek",
    name: "DeepSeek",
    host: "api.deepseek.com",
    confidence: "low",
  },
  {
    id: "dashscope",
    name: "阿里云百炼",
    host: "dashscope.aliyuncs.com",
    confidence: "low",
  },
];
const result: DetectResult = {
  provider: {
    id: "deepseek",
    name: "DeepSeek",
    icon: "deepseek",
    iconColor: "#1E88E5",
    websiteUrl: "https://platform.deepseek.com",
    isCustom: false,
  },
  apiKey: DEMO_KEY,
  keyMasked: "sk-3f9…1a64",
  modelsBaseUrl: "https://api.deepseek.com",
  latencyMs: 312,
  models: [
    "deepseek-flash",
    "deepseek-v4-pro",
    "deepseek-chat",
    "deepseek-reasoner",
  ],
  totalModels: 4,
  apps: {
    claude: {
      preset: "DeepSeek",
      baseUrl: "https://api.deepseek.com/anthropic",
      needsProxy: false,
      enabled: true,
    },
    codex: {
      preset: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      needsProxy: false,
      enabled: true,
    },
    gemini: null,
  },
  suggested: {
    claude: {
      main: "deepseek-v4-pro",
      opus: "deepseek-v4-pro",
      sonnet: "deepseek-v4-pro",
      haiku: "deepseek-flash",
    },
    codex: "deepseek-v4-pro",
    gemini: null,
  },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// 截图脚本把 hold 设为 1 时探测停在进度页
const hold = params.get("hold") === "1";

mockIPC(async (cmd, args: any) => {
  switch (cmd) {
    case "quick_add_preview":
      return { keyMasked: "sk-3f9…1a64", baseUrl: null, candidates };
    case "quick_add_detect": {
      const send = (e: ProbeEvent) => args.onEvent.onmessage(e);
      send({ candidateId: "deepseek", status: "probing" });
      send({ candidateId: "dashscope", status: "probing" });
      await sleep(300);
      send({
        candidateId: "dashscope",
        status: "rejected",
        latencyMs: 241,
        message: "HTTP 401",
      });
      if (hold) {
        send({
          candidateId: "deepseek",
          status: "hit",
          latencyMs: 312,
          message: "4 个模型",
        });
        await new Promise(() => {});
      }
      await sleep(200);
      send({ candidateId: "deepseek", status: "hit", latencyMs: 312 });
      return result;
    }
    default:
      return true;
  }
});

function Page() {
  const [open, setOpen] = React.useState(params.get("view") !== "settings");
  return (
    <div className="min-h-screen bg-app p-6 text-fg-1">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <div className="flex items-center justify-between">
          <span className="font-serif text-page">Jcc Switch</span>
          <Button variant="solid" onClick={() => setOpen(true)}>
            粘贴 Key
          </Button>
        </div>
        {params.get("view") === "settings" && (
          <div className="rounded-dialog border border-border bg-surface p-4">
            <div className="mb-3 text-body">色卡</div>
            <SwatchPicker />
          </div>
        )}
      </div>
      <QuickAddDialog
        open={open}
        onOpenChange={setOpen}
        initialText={params.get("text") ?? ""}
      />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <Page />
  </QueryClientProvider>,
);
