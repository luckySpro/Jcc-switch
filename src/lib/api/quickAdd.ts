import { Channel, invoke } from "@tauri-apps/api/core";

export type Confidence = "low" | "medium" | "high";

export interface QuickAddCandidate {
  id: string;
  name: string;
  host: string;
  confidence: Confidence;
}

export interface PastePreview {
  keyMasked: string | null;
  baseUrl: string | null;
  candidates: QuickAddCandidate[];
}

export type ProbeStatus =
  | "probing"
  | "hit"
  | "rejected"
  | "error"
  | "cancelled";

export interface ProbeEvent {
  candidateId: string;
  status: ProbeStatus;
  latencyMs?: number;
  message?: string;
}

export interface AppPlan {
  preset?: string;
  baseUrl?: string;
  apiKeyField?: "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY";
  needsProxy: boolean;
  enabled: boolean;
}

export interface ClaudeSlots {
  main: string;
  opus: string;
  sonnet: string;
  haiku: string;
}

export interface DetectResult {
  provider: {
    id: string;
    name: string;
    icon?: string | null;
    iconColor?: string | null;
    websiteUrl?: string | null;
    isCustom: boolean;
  };
  apiKey: string;
  keyMasked: string;
  modelsBaseUrl: string;
  latencyMs: number;
  models: string[];
  totalModels: number;
  apps: {
    claude: AppPlan | null;
    codex: AppPlan | null;
    gemini: AppPlan | null;
  };
  suggested: {
    claude: ClaudeSlots | null;
    codex: string | null;
    gemini: string | null;
  };
}

export const quickAddApi = {
  /** 不联网：解析粘贴内容，列出要探测的供应商与域名 */
  async preview(text: string): Promise<PastePreview> {
    return await invoke("quick_add_preview", { text });
  },

  /** 探测供应商并拉取模型，进度逐条回调 */
  async detect(
    text: string,
    onEvent: (event: ProbeEvent) => void,
  ): Promise<DetectResult> {
    const channel = new Channel<ProbeEvent>();
    channel.onmessage = onEvent;
    return await invoke("quick_add_detect", { text, onEvent: channel });
  },
};
