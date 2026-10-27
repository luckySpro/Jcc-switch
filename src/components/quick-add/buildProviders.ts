/**
 * 把识别结果套进上游预设，生成要保存的 Provider。
 *
 * 规则表里写了预设名时用该预设的配置做底（保留它的协议、分类、图标等细节），
 * 只替换 Key、地址和模型；找不到预设就用通用模板。
 */
import type { Provider, ProviderMeta } from "@/types";
import type { ClaudeSlots, DetectResult } from "@/lib/api/quickAdd";
import { providerPresets } from "@/config/claudeProviderPresets";
import {
  codexProviderPresets,
  generateThirdPartyAuth,
  generateThirdPartyConfig,
} from "@/config/codexProviderPresets";
import { geminiProviderPresets } from "@/config/geminiProviderPresets";

export type QuickAddApp = "claude" | "codex" | "gemini";

export interface QuickAddSelection {
  claude: { enabled: boolean; slots: ClaudeSlots } | null;
  codex: { enabled: boolean; model: string } | null;
  gemini: { enabled: boolean; model: string } | null;
}

export interface BuiltProvider {
  app: QuickAddApp;
  provider: Omit<Provider, "id">;
}

const findClaudePreset = (name?: string) =>
  name ? providerPresets.find((p) => p.name === name) : undefined;
const findCodexPreset = (name?: string) =>
  name ? codexProviderPresets.find((p) => p.name === name) : undefined;
const findGeminiPreset = (name?: string) =>
  name ? geminiProviderPresets.find((p) => p.name === name) : undefined;

/** 预设里的模型名可能带 `[1M]` 这类上下文标记，比较时去掉 */
const bareModel = (m: string) => m.replace(/\[[^\]]*\]$/, "").trim();

/** 预设默认模型在拉到的列表里时优先用预设值（含 `[1M]` 标记），否则用建议值 */
function preferPreset(
  presetValue: unknown,
  models: string[],
  fallback: string,
): string {
  if (typeof presetValue === "string" && presetValue) {
    if (models.includes(bareModel(presetValue))) return presetValue;
  }
  return fallback;
}

const EMPTY_SLOTS: ClaudeSlots = { main: "", opus: "", sonnet: "", haiku: "" };

/**
 * 识别结果对应的默认勾选和模型。
 * 应用有可用地址但没挑出合适模型时也给一份空的选择，默认不勾选，用户可以手填模型名后启用。
 */
export function defaultSelection(result: DetectResult): QuickAddSelection {
  const { apps, suggested, models } = result;

  let claude: QuickAddSelection["claude"] = null;
  if (apps.claude && !suggested.claude) {
    claude = { enabled: false, slots: { ...EMPTY_SLOTS } };
  } else if (apps.claude && suggested.claude) {
    const env = (findClaudePreset(apps.claude.preset)?.settingsConfig as any)
      ?.env as Record<string, unknown> | undefined;
    const s = suggested.claude;
    claude = {
      enabled: apps.claude.enabled,
      slots: {
        main: preferPreset(env?.ANTHROPIC_MODEL, models, s.main),
        opus: preferPreset(env?.ANTHROPIC_DEFAULT_OPUS_MODEL, models, s.opus),
        sonnet: preferPreset(
          env?.ANTHROPIC_DEFAULT_SONNET_MODEL,
          models,
          s.sonnet,
        ),
        haiku: preferPreset(
          env?.ANTHROPIC_DEFAULT_HAIKU_MODEL,
          models,
          s.haiku,
        ),
      },
    };
  }

  let codex: QuickAddSelection["codex"] = null;
  if (apps.codex && !suggested.codex) {
    codex = { enabled: false, model: "" };
  } else if (apps.codex && suggested.codex) {
    const presetModel = findCodexPreset(apps.codex.preset)?.config.match(
      /^model\s*=\s*"([^"]*)"/m,
    )?.[1];
    codex = {
      enabled: apps.codex.enabled,
      model: preferPreset(presetModel, models, suggested.codex),
    };
  }

  let gemini: QuickAddSelection["gemini"] = null;
  if (apps.gemini && !suggested.gemini) {
    gemini = { enabled: false, model: "" };
  } else if (apps.gemini && suggested.gemini) {
    gemini = {
      enabled: apps.gemini.enabled,
      model: preferPreset(
        findGeminiPreset(apps.gemini.preset)?.model,
        models,
        suggested.gemini,
      ),
    };
  }

  return { claude, codex, gemini };
}

function baseFields(result: DetectResult) {
  const { provider } = result;
  return {
    name: provider.name,
    websiteUrl: provider.websiteUrl ?? undefined,
    icon: provider.icon ?? undefined,
    iconColor: provider.iconColor ?? undefined,
    category: provider.isCustom
      ? ("custom" as const)
      : ("third_party" as const),
  };
}

function customEndpointsMeta(url?: string): ProviderMeta | undefined {
  if (!url) return undefined;
  return { custom_endpoints: { [url]: { url, addedAt: Date.now() } } };
}

function setTomlString(config: string, key: string, value: string): string {
  const line = `${key} = ${JSON.stringify(value)}`;
  const re = new RegExp(`^${key}\\s*=.*$`, "m");
  return re.test(config) ? config.replace(re, line) : config;
}

function buildClaude(
  result: DetectResult,
  slots: ClaudeSlots,
): Omit<Provider, "id"> {
  const plan = result.apps.claude!;
  const preset = findClaudePreset(plan.preset);
  const presetConfig = (preset?.settingsConfig ?? {}) as Record<string, any>;
  const env: Record<string, unknown> = { ...(presetConfig.env ?? {}) };

  const keyField =
    plan.apiKeyField ?? preset?.apiKeyField ?? "ANTHROPIC_AUTH_TOKEN";
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  env[keyField] = result.apiKey;
  if (plan.baseUrl) env.ANTHROPIC_BASE_URL = plan.baseUrl;
  env.ANTHROPIC_MODEL = slots.main;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = slots.opus;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = slots.sonnet;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = slots.haiku;

  const meta: ProviderMeta = {
    ...(customEndpointsMeta(plan.baseUrl) ?? {}),
    ...(preset?.apiFormat && preset.apiFormat !== "anthropic"
      ? { apiFormat: preset.apiFormat }
      : {}),
    ...(keyField !== "ANTHROPIC_AUTH_TOKEN" ? { apiKeyField: keyField } : {}),
  };

  return {
    ...baseFields(result),
    ...(preset?.category ? { category: preset.category } : {}),
    settingsConfig: { ...presetConfig, env },
    meta,
  };
}

function buildCodex(result: DetectResult, model: string): Omit<Provider, "id"> {
  const plan = result.apps.codex!;
  const preset = findCodexPreset(plan.preset);
  let config: string;
  if (preset) {
    config = setTomlString(preset.config, "model", model);
    if (plan.baseUrl) config = setTomlString(config, "base_url", plan.baseUrl);
  } else {
    const slug =
      result.provider.id === "custom"
        ? "custom"
        : result.provider.id.replace(/[^a-z0-9_-]/gi, "");
    config = generateThirdPartyConfig(slug, plan.baseUrl ?? "", model);
  }

  const meta: ProviderMeta = {
    ...(customEndpointsMeta(plan.baseUrl) ?? {}),
    ...(preset?.apiFormat ? { apiFormat: preset.apiFormat } : {}),
  };

  return {
    ...baseFields(result),
    ...(preset?.category ? { category: preset.category } : {}),
    settingsConfig: { auth: generateThirdPartyAuth(result.apiKey), config },
    meta,
  };
}

function buildGemini(
  result: DetectResult,
  model: string,
): Omit<Provider, "id"> {
  const plan = result.apps.gemini!;
  const preset = findGeminiPreset(plan.preset);
  const presetConfig = (preset?.settingsConfig ?? {}) as Record<string, any>;
  const env: Record<string, unknown> = { ...(presetConfig.env ?? {}) };
  env.GEMINI_API_KEY = result.apiKey;
  env.GEMINI_MODEL = model;
  if (plan.baseUrl) {
    env.GOOGLE_GEMINI_BASE_URL = plan.baseUrl;
  } else {
    delete env.GOOGLE_GEMINI_BASE_URL;
  }
  return {
    ...baseFields(result),
    ...(preset?.category ? { category: preset.category } : {}),
    settingsConfig: { ...presetConfig, env },
    meta: customEndpointsMeta(plan.baseUrl) ?? {},
  };
}

export function buildQuickAddProviders(
  result: DetectResult,
  selection: QuickAddSelection,
): BuiltProvider[] {
  const out: BuiltProvider[] = [];
  if (selection.claude?.enabled && result.apps.claude) {
    out.push({
      app: "claude",
      provider: buildClaude(result, selection.claude.slots),
    });
  }
  if (selection.codex?.enabled && result.apps.codex) {
    out.push({
      app: "codex",
      provider: buildCodex(result, selection.codex.model),
    });
  }
  if (selection.gemini?.enabled && result.apps.gemini) {
    out.push({
      app: "gemini",
      provider: buildGemini(result, selection.gemini.model),
    });
  }
  return out;
}

/** 勾选了但模型名还空着的应用；有这样的应用时不能保存 */
export function appsMissingModel(selection: QuickAddSelection): QuickAddApp[] {
  const out: QuickAddApp[] = [];
  if (
    selection.claude?.enabled &&
    Object.values(selection.claude.slots).some((m) => !m.trim())
  ) {
    out.push("claude");
  }
  if (selection.codex?.enabled && !selection.codex.model.trim()) {
    out.push("codex");
  }
  if (selection.gemini?.enabled && !selection.gemini.model.trim()) {
    out.push("gemini");
  }
  return out;
}

/** 将要写入的文件，供确认页预览 */
export const QUICK_ADD_FILES: Record<QuickAddApp, string[]> = {
  claude: ["~/.claude/settings.json"],
  codex: ["~/.codex/config.toml", "~/.codex/auth.json"],
  gemini: ["~/.gemini/.env", "~/.gemini/settings.json"],
};
