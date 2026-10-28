import { describe, expect, it } from "vitest";
import type { DetectResult } from "@/lib/api/quickAdd";
import {
  buildMoreProviders,
  defaultMoreSelection,
  endpointsOf,
  MORE_APPS,
  moreAvailability,
  moreMissingModel,
  providerKeyBase,
  routeFor,
  uniqueKey,
  visibleMoreApps,
  type MoreApp,
} from "./moreApps";

const KEY = "sk-relay7Hk2abcdefghij1234";

/** 只有 Claude 模型的中转站，形如 fangcunapi.com */
function relay(overrides: Partial<DetectResult> = {}): DetectResult {
  return {
    provider: {
      id: "custom",
      name: "fangcunapi.com",
      isCustom: true,
    },
    apiKey: KEY,
    keyMasked: "sk-rel…1234",
    modelsBaseUrl: "https://fangcunapi.com",
    latencyMs: 528,
    models: [
      "claude-haiku-5-5",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-sonnet-4-6",
    ],
    totalModels: 4,
    apps: {
      claude: {
        baseUrl: "https://fangcunapi.com",
        needsProxy: false,
        enabled: true,
      },
      codex: {
        baseUrl: "https://fangcunapi.com/v1",
        needsProxy: false,
        enabled: true,
      },
      gemini: {
        baseUrl: "https://fangcunapi.com",
        needsProxy: false,
        enabled: false,
      },
    },
    suggested: {
      claude: {
        main: "claude-sonnet-5-5",
        opus: "claude-opus-5-5",
        sonnet: "claude-sonnet-5-5",
        haiku: "claude-haiku-5-5",
      },
      codex: "claude-opus-5-5",
      gemini: null,
    },
    ...overrides,
  };
}

function buildAll(r: DetectResult, model = "claude-opus-5-5") {
  const apps = Object.fromEntries(MORE_APPS.map((a) => [a, true]));
  const keys = Object.fromEntries(
    MORE_APPS.map((a) => [a, "fangcunapi"]),
  ) as Partial<Record<MoreApp, string>>;
  const built = buildMoreProviders(
    r,
    { apps, model, grokModel: "grok-4.5" },
    r.suggested.claude,
    keys,
  );
  return Object.fromEntries(built.map((b) => [b.app, b]));
}

describe("more apps", () => {
  it("derives both protocol endpoints from the relay plans", () => {
    expect(endpointsOf(relay())).toEqual({
      anthropic: "https://fangcunapi.com",
      openai: "https://fangcunapi.com/v1",
    });
  });

  it("routes Claude models over Anthropic and others over OpenAI", () => {
    const ep = endpointsOf(relay());
    expect(routeFor("claude-opus-5-5", ep)?.api).toBe("anthropic");
    expect(routeFor("glm-5.1", ep)).toEqual({
      api: "openai",
      baseUrl: "https://fangcunapi.com/v1",
    });
    expect(routeFor("glm-5.1", { anthropic: "https://x" })?.api).toBe(
      "anthropic",
    );
  });

  it("writes the key into every app's own config shape", () => {
    const b = buildAll(relay());

    const desktop = b["claude-desktop"].provider;
    expect(desktop.meta?.claudeDesktopMode).toBe("direct");
    expect(Object.keys(desktop.meta?.claudeDesktopModelRoutes ?? {})).toEqual([
      "claude-sonnet-5-5",
      "claude-opus-5-5",
      "claude-haiku-5-5",
    ]);
    expect((desktop.settingsConfig as any).env).toEqual({
      ANTHROPIC_BASE_URL: "https://fangcunapi.com",
      ANTHROPIC_AUTH_TOKEN: KEY,
    });

    const opencode = b.opencode.provider.settingsConfig as any;
    expect(opencode.npm).toBe("@ai-sdk/anthropic");
    expect(opencode.options).toEqual({
      baseURL: "https://fangcunapi.com/v1",
      apiKey: KEY,
    });
    expect(Object.keys(opencode.models)[0]).toBe("claude-opus-5-5");
    expect(b.opencode.providerKey).toBe("fangcunapi");

    const openclaw = b.openclaw;
    expect((openclaw.provider.settingsConfig as any).api).toBe(
      "anthropic-messages",
    );
    expect(openclaw.openclawDefaults?.model?.primary).toBe(
      "fangcunapi/claude-opus-5-5",
    );

    const hermes = b.hermes.provider.settingsConfig as any;
    expect(hermes.api_mode).toBe("anthropic_messages");
    expect(hermes.api_key).toBe(KEY);

    const pi = b.pi.provider.settingsConfig as any;
    expect(pi).toMatchObject({
      baseUrl: "https://fangcunapi.com",
      api: "anthropic-messages",
      apiKey: KEY,
    });
    expect(pi.models[0].id).toBe("claude-opus-5-5");

    expect((b.omp.provider.settingsConfig as any).apiKey).toBe(KEY);
    expect((b.mcode.provider.settingsConfig as any).options.apiKey).toBe(KEY);
    expect((b.dsh.provider.settingsConfig as any).options.apiKey).toBe(KEY);
    expect((b.kimi.provider.settingsConfig as any).provider).toMatchObject({
      type: "anthropic",
      base_url: "https://fangcunapi.com",
      api_key: KEY,
    });

    const grok = b.grokbuild.provider;
    expect((grok.settingsConfig as any).config).toContain(
      'base_url = "https://fangcunapi.com/v1"',
    );
    expect(grok.meta?.apiFormat).toBe("openai_responses");
  });

  it("uses OpenAI-compatible configs for non-Claude models", () => {
    const b = buildAll(relay(), "glm-5.1");
    expect((b.opencode.provider.settingsConfig as any).npm).toBe(
      "@ai-sdk/openai-compatible",
    );
    expect((b.pi.provider.settingsConfig as any).api).toBe(
      "openai-completions",
    );
    expect((b.kimi.provider.settingsConfig as any).provider.type).toBe(
      "openai",
    );
  });

  it("maps non-Claude models onto Claude Desktop role routes via the proxy", () => {
    const glm = {
      main: "glm-5.1",
      opus: "glm-5.1",
      sonnet: "glm-5.1",
      haiku: "glm-4.7-flash",
    };
    const r = relay({
      suggested: { claude: glm, codex: "glm-5.1", gemini: null },
    });
    expect(moreAvailability(r, endpointsOf(r), true)["claude-desktop"]).toBe(
      "needsProxy",
    );
    const desktop = buildAll(r)["claude-desktop"].provider;
    expect(desktop.meta?.claudeDesktopMode).toBe("proxy");
    expect(
      Object.values(desktop.meta?.claudeDesktopModelRoutes ?? {}).map(
        (route) => route.model,
      ),
    ).toEqual(["glm-5.1", "glm-5.1", "glm-4.7-flash"]);
  });

  it("starts from the same-name preset for official providers", () => {
    const r: DetectResult = {
      ...relay(),
      provider: {
        id: "deepseek",
        name: "DeepSeek",
        isCustom: false,
      },
      models: ["deepseek-v4-pro", "deepseek-flash"],
      apps: {
        claude: { preset: "DeepSeek", needsProxy: false, enabled: true },
        codex: { preset: "DeepSeek", needsProxy: false, enabled: true },
        gemini: null,
      },
    };
    const pi = buildAll(r, "deepseek-v4-pro").pi.provider.settingsConfig as any;
    expect(pi.baseUrl).toContain("deepseek.com");
    expect(pi.apiKey).toBe(KEY);
    expect(pi.models.some((m: any) => m.id === "deepseek-v4-pro")).toBe(true);
  });

  it("gates Grok Build on Grok models and the Responses probe", () => {
    const ep = endpointsOf(relay());
    expect(moreAvailability(relay(), ep, true).grokbuild).toBe("noGrokModel");
    const grok = relay({ models: [...relay().models, "grok-4.5"] });
    expect(moreAvailability(grok, ep, null).grokbuild).toBe("probing");
    expect(moreAvailability(grok, ep, false).grokbuild).toBe("unsupported");
    expect(moreAvailability(grok, ep, true).grokbuild).toBe("ok");
    expect(defaultMoreSelection(grok).grokModel).toBe("grok-4.5");
  });

  it("starts with nothing checked and the Codex suggestion as model", () => {
    const sel = defaultMoreSelection(relay());
    expect(sel.apps).toEqual({});
    expect(sel.model).toBe("claude-opus-5-5");
    expect(
      moreMissingModel({ apps: { pi: true }, model: " ", grokModel: "" }),
    ).toEqual(["pi"]);
    expect(
      moreMissingModel({
        apps: { "claude-desktop": true },
        model: "",
        grokModel: "",
      }),
    ).toEqual([]);
  });

  it("derives a valid, unique provider key", () => {
    expect(providerKeyBase(relay(), endpointsOf(relay()))).toBe(
      "fangcunapi-com",
    );
    const chinese = relay({
      provider: { id: "custom", name: "claude官转", isCustom: true },
    });
    expect(providerKeyBase(chinese, endpointsOf(chinese))).toBe("claude");
    const noAscii = relay({
      provider: { id: "custom", name: "官转", isCustom: true },
    });
    expect(providerKeyBase(noAscii, endpointsOf(noAscii))).toBe("fangcunapi");
    expect(uniqueKey("relay", ["relay", "relay-2"])).toBe("relay-3");
  });

  it("only offers apps shown in the sidebar", () => {
    expect(visibleMoreApps({ pi: false, kimi: false })).not.toContain("pi");
    expect(visibleMoreApps(undefined)).toHaveLength(MORE_APPS.length);
  });
});
