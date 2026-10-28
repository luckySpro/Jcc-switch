/**
 * 「更多应用」：把同一个 Key 写进 Claude Code / Codex / Gemini 之外的应用。
 *
 * 识别结果里已有两类地址：Anthropic 协议的根地址（Claude Code 用）和 OpenAI 协议的
 * `/v1` 地址（Codex 用）。这里按模型选协议：Claude 系模型走 Anthropic，其余走 OpenAI，
 * 再套进各应用的配置结构。官方供应商在该应用的预设里有同名条目时，以预设为底。
 */
import type { AppId } from "@/lib/api/types";
import type { ClaudeSlots, DetectResult } from "@/lib/api/quickAdd";
import type {
  ClaudeDesktopModelRoute,
  OpenCodeProviderConfig,
  OpenClawProviderConfig,
  Provider,
  ProviderMeta,
} from "@/types";
import { providerPresets } from "@/config/claudeProviderPresets";
import { codexProviderPresets } from "@/config/codexProviderPresets";
import {
  CLAUDE_DESKTOP_ROLE_ROUTE_IDS,
  claudeDesktopProviderPresets,
} from "@/config/claudeDesktopProviderPresets";
import { opencodeProviderPresets } from "@/config/opencodeProviderPresets";
import {
  openclawProviderPresets,
  rebaseOpenClawSuggestedDefaults,
  type OpenClawSuggestedDefaults,
} from "@/config/openclawProviderPresets";
import {
  hermesProviderPresets,
  type HermesProviderSettingsConfig,
} from "@/config/hermesProviderPresets";
import {
  piProviderPresets,
  type PiApiFormat,
  type PiPresetModel,
  type PiProviderPreset,
} from "@/config/piProviderPresets";
import { toOmpPreset } from "@/config/ompProviderPresets";
import { toMcodePresets } from "@/config/mcodeProviderPresets";
import { toDshPresets } from "@/config/dshProviderPresets";
import { toKimiPresets } from "@/config/kimiProviderPresets";
import {
  buildGrokBuildConfig,
  GROK_BUILD_DEFAULT_API_BACKEND,
  GROK_BUILD_DEFAULT_CONTEXT_WINDOW,
} from "@/utils/grokBuildConfig";

export type MoreApp =
  | "claude-desktop"
  | "opencode"
  | "openclaw"
  | "hermes"
  | "pi"
  | "omp"
  | "mcode"
  | "dsh"
  | "kimi"
  | "grokbuild";

export const MORE_APPS: MoreApp[] = [
  "claude-desktop",
  "opencode",
  "openclaw",
  "hermes",
  "pi",
  "omp",
  "mcode",
  "dsh",
  "kimi",
  "grokbuild",
];

export const MORE_APP_LABELS: Record<MoreApp, string> = {
  "claude-desktop": "Claude Desktop",
  opencode: "OpenCode",
  openclaw: "OpenClaw",
  hermes: "Hermes",
  pi: "Pi",
  omp: "Oh My Pi",
  mcode: "MiniMax Code",
  dsh: "DeepSeek Harness",
  kimi: "Kimi Code",
  grokbuild: "Grok Build",
};

/** 以供应商标识为主键、追加写入配置的应用：保存时要给一个不重复的 key */
export const KEYED_MORE_APPS: ReadonlySet<MoreApp> = new Set([
  "opencode",
  "openclaw",
  "hermes",
  "pi",
  "omp",
  "mcode",
  "dsh",
  "kimi",
]);

export interface MoreSelection {
  apps: Partial<Record<MoreApp, boolean>>;
  /** Claude Desktop 之外的应用共用的默认模型 */
  model: string;
  /** Grok Build 的模型 */
  grokModel: string;
}

export interface Endpoints {
  /** Anthropic 协议根地址（不带 /v1） */
  anthropic?: string;
  /** OpenAI 协议地址（带 /v1） */
  openai?: string;
}

export type MoreAvailability = Partial<
  Record<
    MoreApp,
    "ok" | "needsProxy" | "probing" | "unsupported" | "noGrokModel"
  >
>;

const trimSlash = (url: string) => url.trim().replace(/\/+$/, "");

/** 规则表里写的预设名；其它应用的同名预设以它为准 */
export function presetName(result: DetectResult): string | undefined {
  if (result.provider.isCustom) return undefined;
  return result.apps.codex?.preset ?? result.apps.claude?.preset;
}

export function endpointsOf(result: DetectResult): Endpoints {
  const { apps } = result;
  let anthropic = apps.claude?.baseUrl;
  if (!anthropic && apps.claude?.preset) {
    const preset = providerPresets.find((p) => p.name === apps.claude?.preset);
    const env = (preset?.settingsConfig as any)?.env;
    if (
      (!preset?.apiFormat || preset.apiFormat === "anthropic") &&
      typeof env?.ANTHROPIC_BASE_URL === "string"
    ) {
      anthropic = env.ANTHROPIC_BASE_URL;
    }
  }
  let openai = apps.codex?.baseUrl;
  if (!openai && apps.codex?.preset) {
    const preset = codexProviderPresets.find(
      (p) => p.name === apps.codex?.preset,
    );
    openai = preset?.config.match(/^base_url\s*=\s*"([^"]*)"/m)?.[1];
  }
  return {
    anthropic: anthropic ? trimSlash(anthropic) : undefined,
    openai: openai ? trimSlash(openai) : undefined,
  };
}

const isClaudeModel = (model: string) => /claude/i.test(model);
const isGrokModel = (model: string) => /grok/i.test(model);

/** 这个模型用哪种协议、哪个地址 */
export function routeFor(
  model: string,
  endpoints: Endpoints,
): { api: "anthropic" | "openai"; baseUrl: string } | null {
  if (endpoints.anthropic && (isClaudeModel(model) || !endpoints.openai)) {
    return { api: "anthropic", baseUrl: endpoints.anthropic };
  }
  if (endpoints.openai) return { api: "openai", baseUrl: endpoints.openai };
  return null;
}

/** Claude Desktop 直连模式只接受 Claude 角色名开头的模型 ID */
const isClaudeSafeModel = (model: string) =>
  !/\[1m\]/i.test(model) &&
  /^(anthropic\/)?claude-(sonnet|opus|haiku|fable)-[a-z0-9]/i.test(
    model.trim(),
  );

export function moreAvailability(
  result: DetectResult,
  endpoints: Endpoints,
  responses: boolean | null,
): MoreAvailability {
  const out: MoreAvailability = {};
  const hasAny = Boolean(endpoints.anthropic || endpoints.openai);
  if (endpoints.anthropic && result.apps.claude) {
    const slots = result.suggested.claude;
    const direct =
      slots && [slots.sonnet, slots.opus, slots.haiku].every(isClaudeSafeModel);
    out["claude-desktop"] = direct ? "ok" : "needsProxy";
  }
  for (const app of MORE_APPS) {
    if (app === "claude-desktop" || app === "grokbuild") continue;
    if (hasAny) out[app] = "ok";
  }
  // Grok CLI 只能用 Grok 模型，列表里没有就不提供
  if (endpoints.openai) {
    out.grokbuild = !result.models.some(isGrokModel)
      ? "noGrokModel"
      : responses === null
        ? "probing"
        : responses
          ? "ok"
          : "unsupported";
  }
  return out;
}

export function defaultMoreSelection(result: DetectResult): MoreSelection {
  const { suggested, models } = result;
  const model = suggested.codex ?? suggested.claude?.main ?? models[0] ?? "";
  const grok = models.filter(isGrokModel);
  return {
    apps: {},
    model,
    grokModel: grok[0] ?? model,
  };
}

/** 供应商标识的基础部分：取名称里的 ASCII 片段，没有就用地址的主机名 */
export function providerKeyBase(result: DetectResult, endpoints: Endpoints) {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const fromName = slug(result.provider.name);
  if (fromName.length >= 2) return fromName;
  const url = endpoints.openai ?? endpoints.anthropic ?? result.modelsBaseUrl;
  try {
    const host = new URL(url).hostname
      .split(".")
      .filter((p) => !["api", "www"].includes(p));
    return slug(host.slice(0, -1).join("-") || host.join("-")) || "relay";
  } catch {
    return "relay";
  }
}

export function uniqueKey(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i += 1) {
    const key = `${base}-${i}`;
    if (!taken.includes(key)) return key;
  }
}

/** 写进配置的模型：选中的放第一，再带上其它建议模型，最多 6 个 */
function modelList(result: DetectResult, primary: string): string[] {
  const s = result.suggested;
  const extra = [
    s.claude?.main,
    s.claude?.opus,
    s.claude?.sonnet,
    s.claude?.haiku,
    s.codex,
    s.gemini,
  ].filter((m): m is string => Boolean(m) && result.models.includes(m!));
  return [...new Set([primary, ...extra])].slice(0, 6);
}

function genericModel(id: string): PiPresetModel {
  const claude = isClaudeModel(id);
  return {
    id,
    name: id,
    reasoning: claude,
    input: claude ? ["text", "image"] : ["text"],
    contextWindow: claude ? 200000 : 128000,
    maxTokens: claude ? 32000 : 8192,
  } as PiPresetModel;
}

const PI_API: Record<"anthropic" | "openai", PiApiFormat> = {
  anthropic: "anthropic-messages",
  openai: "openai-completions",
};

/** 一份 Pi 形态的描述，Pi 及其衍生应用（OMP / MiniMax Code / DSH / Kimi Code）都从它转换 */
function piSource(
  result: DetectResult,
  endpoints: Endpoints,
  model: string,
  key: string,
): PiProviderPreset | null {
  const name = presetName(result);
  const preset = name
    ? piProviderPresets.find((p) => p.name === name)
    : undefined;
  if (preset) {
    const models = preset.settingsConfig.models.some((m) => m.id === model)
      ? preset.settingsConfig.models
      : [genericModel(model), ...preset.settingsConfig.models];
    return {
      ...preset,
      providerKey: key,
      settingsConfig: {
        ...preset.settingsConfig,
        apiKey: result.apiKey,
        models,
      },
    };
  }
  const route = routeFor(model, endpoints);
  if (!route) return null;
  return {
    name: result.provider.name,
    providerKey: key,
    websiteUrl: result.provider.websiteUrl ?? "",
    settingsConfig: {
      name: result.provider.name,
      baseUrl: route.baseUrl,
      api: PI_API[route.api],
      apiKey: result.apiKey,
      models: modelList(result, model).map(genericModel),
    },
  };
}

/** JSON 往返：去掉模型目录里的 Symbol 引用等不可序列化的字段 */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export interface BuiltMoreProvider {
  app: MoreApp;
  provider: Omit<Provider, "id">;
  /** 追加型应用的供应商标识（同时是 id） */
  providerKey?: string;
  openclawDefaults?: OpenClawSuggestedDefaults;
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

function buildClaudeDesktop(
  result: DetectResult,
  endpoints: Endpoints,
  slots: ClaudeSlots,
): Omit<Provider, "id"> | null {
  const name = presetName(result);
  const preset = name
    ? claudeDesktopProviderPresets.find((p) => p.name === name)
    : undefined;
  const baseUrl = preset?.baseUrl || endpoints.anthropic;
  if (!baseUrl) return null;
  const keyField = result.apps.claude?.apiKeyField ?? "ANTHROPIC_AUTH_TOKEN";
  const roles = { sonnet: slots.sonnet, opus: slots.opus, haiku: slots.haiku };
  const direct = Object.values(roles).every(isClaudeSafeModel);
  const routes: Record<string, ClaudeDesktopModelRoute> = {};
  for (const [role, model] of Object.entries(roles)) {
    if (direct) {
      routes[model] = { model };
    } else {
      const routeId =
        CLAUDE_DESKTOP_ROLE_ROUTE_IDS[
          role as keyof typeof CLAUDE_DESKTOP_ROLE_ROUTE_IDS
        ];
      routes[routeId] = { model, labelOverride: model };
    }
  }
  const meta: ProviderMeta = {
    claudeDesktopMode: direct ? "direct" : "proxy",
    apiFormat: direct ? "anthropic" : (preset?.apiFormat ?? "anthropic"),
    claudeDesktopModelRoutes: routes,
    custom_endpoints: { [baseUrl]: { url: baseUrl, addedAt: Date.now() } },
  };
  return {
    ...baseFields(result),
    ...(preset?.category ? { category: preset.category } : {}),
    settingsConfig: {
      env: {
        ANTHROPIC_BASE_URL: trimSlash(baseUrl),
        [keyField]: result.apiKey,
      },
    },
    meta,
  };
}

function buildOpenCode(
  result: DetectResult,
  endpoints: Endpoints,
  model: string,
): Omit<Provider, "id"> | null {
  const name = presetName(result);
  const preset = name
    ? opencodeProviderPresets.find((p) => p.name === name)
    : undefined;
  let config: OpenCodeProviderConfig;
  if (preset) {
    config = plain(preset.settingsConfig);
    config.options = { ...config.options, apiKey: result.apiKey };
    config.models = { [model]: { name: model }, ...config.models };
  } else {
    const route = routeFor(model, endpoints);
    if (!route) return null;
    config = {
      npm:
        route.api === "anthropic"
          ? "@ai-sdk/anthropic"
          : "@ai-sdk/openai-compatible",
      name: result.provider.name,
      options: {
        baseURL:
          route.api === "anthropic" ? `${route.baseUrl}/v1` : route.baseUrl,
        apiKey: result.apiKey,
      },
      models: Object.fromEntries(
        modelList(result, model).map((id) => [id, { name: id }]),
      ),
    };
  }
  return { ...baseFields(result), settingsConfig: config as any };
}

function buildOpenClaw(
  result: DetectResult,
  endpoints: Endpoints,
  model: string,
  key: string,
): {
  provider: Omit<Provider, "id">;
  defaults: OpenClawSuggestedDefaults;
} | null {
  const name = presetName(result);
  const preset = name
    ? openclawProviderPresets.find((p) => p.name === name)
    : undefined;
  let config: OpenClawProviderConfig;
  if (preset) {
    config = plain(preset.settingsConfig);
    config.apiKey = result.apiKey;
    if (!config.models?.some((m) => m.id === model)) {
      config.models = [{ id: model, name: model }, ...(config.models ?? [])];
    }
  } else {
    const route = routeFor(model, endpoints);
    if (!route) return null;
    config = {
      baseUrl: route.baseUrl,
      apiKey: result.apiKey,
      api:
        route.api === "anthropic" ? "anthropic-messages" : "openai-completions",
      models: modelList(result, model).map((id) => {
        const m = genericModel(id);
        return {
          id,
          name: id,
          reasoning: m.reasoning,
          input: m.input,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
        };
      }),
    };
  }
  const defaults = rebaseOpenClawSuggestedDefaults(
    {
      model: { primary: `${key}/${model}` },
      modelCatalog: { [`${key}/${model}`]: { alias: result.provider.name } },
    },
    key,
  );
  return {
    provider: { ...baseFields(result), settingsConfig: config as any },
    defaults,
  };
}

function buildHermes(
  result: DetectResult,
  endpoints: Endpoints,
  model: string,
  key: string,
): Omit<Provider, "id"> | null {
  const name = presetName(result);
  const preset = name
    ? hermesProviderPresets.find((p) => p.name === name)
    : undefined;
  let config: HermesProviderSettingsConfig;
  if (preset) {
    config = plain(preset.settingsConfig);
    config.api_key = result.apiKey;
    if (!config.models?.some((m) => m.id === model)) {
      config.models = [{ id: model, name: model }, ...(config.models ?? [])];
    }
  } else {
    const route = routeFor(model, endpoints);
    if (!route) return null;
    config = {
      name: key,
      base_url: route.baseUrl,
      api_key: result.apiKey,
      api_mode:
        route.api === "anthropic" ? "anthropic_messages" : "chat_completions",
      models: modelList(result, model).map((id) => ({
        id,
        name: id,
        context_length: genericModel(id).contextWindow,
      })),
    };
  }
  return { ...baseFields(result), settingsConfig: config };
}

function buildPiFamily(
  app: "pi" | "omp" | "mcode" | "dsh" | "kimi",
  source: PiProviderPreset,
  result: DetectResult,
): Omit<Provider, "id"> | null {
  const converted =
    app === "pi"
      ? [source]
      : app === "omp"
        ? [toOmpPreset(source)]
        : app === "mcode"
          ? toMcodePresets(source)
          : app === "dsh"
            ? toDshPresets(source)
            : toKimiPresets(source);
  const preset = converted[0];
  if (!preset) return null;
  const settingsConfig = plain(preset.settingsConfig) as Record<string, any>;
  // MiniMax Code 的转换按预设习惯留空 Key，这里补上
  if (settingsConfig.options && !settingsConfig.options.apiKey) {
    settingsConfig.options.apiKey = result.apiKey;
  }
  if (settingsConfig.provider && !settingsConfig.provider.api_key) {
    settingsConfig.provider.api_key = result.apiKey;
  }
  return { ...baseFields(result), settingsConfig };
}

function buildGrokBuild(
  result: DetectResult,
  endpoints: Endpoints,
  model: string,
): Omit<Provider, "id"> | null {
  if (!endpoints.openai) return null;
  const config = buildGrokBuildConfig({
    model,
    upstreamModel: model,
    baseUrl: endpoints.openai,
    name: result.provider.name,
    apiKey: result.apiKey,
    apiBackend: GROK_BUILD_DEFAULT_API_BACKEND,
    contextWindow: GROK_BUILD_DEFAULT_CONTEXT_WINDOW,
  });
  return {
    ...baseFields(result),
    settingsConfig: { config },
    meta: {
      apiFormat: "openai_responses",
      custom_endpoints: {
        [endpoints.openai]: { url: endpoints.openai, addedAt: Date.now() },
      },
    },
  };
}

/**
 * 生成「更多应用」要保存的供应商。`keys` 是每个追加型应用已解析好的不重复标识。
 */
export function buildMoreProviders(
  result: DetectResult,
  selection: MoreSelection,
  claudeSlots: ClaudeSlots | null,
  keys: Partial<Record<MoreApp, string>>,
): BuiltMoreProvider[] {
  const endpoints = endpointsOf(result);
  const out: BuiltMoreProvider[] = [];
  const model = selection.model.trim();
  for (const app of MORE_APPS) {
    if (!selection.apps[app]) continue;
    const key = keys[app] ?? providerKeyBase(result, endpoints);
    if (app === "claude-desktop") {
      const provider = claudeSlots
        ? buildClaudeDesktop(result, endpoints, claudeSlots)
        : null;
      if (provider) out.push({ app, provider });
    } else if (app === "grokbuild") {
      const provider = buildGrokBuild(
        result,
        endpoints,
        selection.grokModel.trim(),
      );
      if (provider) out.push({ app, provider });
    } else if (app === "opencode") {
      const provider = buildOpenCode(result, endpoints, model);
      if (provider) out.push({ app, provider, providerKey: key });
    } else if (app === "openclaw") {
      const built = buildOpenClaw(result, endpoints, model, key);
      if (built) {
        out.push({
          app,
          provider: built.provider,
          providerKey: key,
          openclawDefaults: built.defaults,
        });
      }
    } else if (app === "hermes") {
      const provider = buildHermes(result, endpoints, model, key);
      if (provider) out.push({ app, provider, providerKey: key });
    } else {
      const source = piSource(result, endpoints, model, key);
      const provider = source ? buildPiFamily(app, source, result) : null;
      if (provider) out.push({ app, provider, providerKey: key });
    }
  }
  return out;
}

/** 勾选了但缺模型名的「更多应用」 */
export function moreMissingModel(selection: MoreSelection): MoreApp[] {
  return MORE_APPS.filter(
    (app) =>
      selection.apps[app] &&
      app !== "claude-desktop" &&
      !(app === "grokbuild" ? selection.grokModel : selection.model).trim(),
  );
}

/** 只显示侧栏里开着的应用；没传设置时全部显示 */
export function visibleMoreApps(
  visible?: Partial<Record<AppId, boolean>>,
): MoreApp[] {
  return MORE_APPS.filter((app) => visible?.[app] !== false);
}
