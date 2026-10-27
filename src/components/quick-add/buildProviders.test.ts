import { describe, expect, it } from "vitest";
import type { DetectResult } from "@/lib/api/quickAdd";
import {
  appsMissingModel,
  buildQuickAddProviders,
  defaultSelection,
} from "./buildProviders";
import { looksLikeKeyPaste } from "./usePasteToQuickAdd";

function result(overrides: Partial<DetectResult> = {}): DetectResult {
  return {
    provider: {
      id: "deepseek",
      name: "DeepSeek",
      icon: "deepseek",
      iconColor: "#1E88E5",
      websiteUrl: "https://platform.deepseek.com",
      isCustom: false,
    },
    apiKey: "sk-3f9c2a7e1b4d48e6a0c5f7d2e9b81a64",
    keyMasked: "sk-3f9…1a64",
    modelsBaseUrl: "https://api.deepseek.com",
    latencyMs: 312,
    models: ["deepseek-flash", "deepseek-v4-pro"],
    totalModels: 2,
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
    ...overrides,
  };
}

describe("quick add provider builder", () => {
  it("prefers preset default models when the provider lists them", () => {
    const sel = defaultSelection(result());
    // 上游 DeepSeek 预设默认 deepseek-flash[1M]，拉到的列表里有 deepseek-flash
    expect(sel.claude?.slots.main).toBe("deepseek-flash[1M]");
    expect(sel.codex?.model).toBe("deepseek-flash");
    expect(sel.gemini).toBeNull();
  });

  it("builds claude and codex providers from the presets", () => {
    const r = result();
    const built = buildQuickAddProviders(r, {
      claude: {
        enabled: true,
        slots: { main: "a", opus: "b", sonnet: "c", haiku: "d" },
      },
      codex: { enabled: true, model: "deepseek-v4-pro" },
      gemini: null,
    });
    expect(built.map((b) => b.app)).toEqual(["claude", "codex"]);

    const claude = built[0].provider;
    const env = (claude.settingsConfig as any).env;
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.deepseek.com/anthropic");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(r.apiKey);
    expect(env.ANTHROPIC_MODEL).toBe("a");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("d");
    expect(claude.name).toBe("DeepSeek");

    const codex = built[1].provider.settingsConfig as any;
    expect(codex.auth.OPENAI_API_KEY).toBe(r.apiKey);
    expect(codex.config).toMatch(/^model = "deepseek-v4-pro"$/m);
    expect(codex.config).toMatch(/^base_url = "https:\/\/api.deepseek.com"$/m);
    expect(built[1].provider.meta?.apiFormat).toBe("openai_responses");
  });

  it("skips apps that are switched off", () => {
    const built = buildQuickAddProviders(result(), {
      claude: {
        enabled: false,
        slots: { main: "a", opus: "a", sonnet: "a", haiku: "a" },
      },
      codex: { enabled: true, model: "x" },
      gemini: null,
    });
    expect(built.map((b) => b.app)).toEqual(["codex"]);
  });

  it("uses generic templates for a pasted relay URL", () => {
    const r = result({
      provider: {
        id: "custom",
        name: "relay.example.com",
        isCustom: true,
      },
      apps: {
        claude: {
          baseUrl: "https://relay.example.com",
          needsProxy: false,
          enabled: true,
        },
        codex: {
          baseUrl: "https://relay.example.com/v1",
          needsProxy: false,
          enabled: true,
        },
        gemini: {
          baseUrl: "https://relay.example.com",
          needsProxy: false,
          enabled: true,
        },
      },
      models: ["claude-sonnet-5", "gpt-5.6-sol", "gemini-3.6-pro"],
      suggested: {
        claude: {
          main: "claude-sonnet-5",
          opus: "claude-sonnet-5",
          sonnet: "claude-sonnet-5",
          haiku: "claude-sonnet-5",
        },
        codex: "gpt-5.6-sol",
        gemini: "gemini-3.6-pro",
      },
    });
    const built = buildQuickAddProviders(r, defaultSelection(r));
    expect(built.map((b) => b.app)).toEqual(["claude", "codex", "gemini"]);
    expect(built[0].provider.category).toBe("custom");
    expect(
      (built[0].provider.settingsConfig as any).env.ANTHROPIC_BASE_URL,
    ).toBe("https://relay.example.com");
    const codex = (built[1].provider.settingsConfig as any).config as string;
    expect(codex).toContain('base_url = "https://relay.example.com/v1"');
    expect(codex).toContain('model = "gpt-5.6-sol"');
    const gemini = (built[2].provider.settingsConfig as any).env;
    expect(gemini).toEqual({
      GEMINI_API_KEY: r.apiKey,
      GEMINI_MODEL: "gemini-3.6-pro",
      GOOGLE_GEMINI_BASE_URL: "https://relay.example.com",
    });
  });

  it("writes ANTHROPIC_API_KEY when the rule asks for it", () => {
    const r = result({
      provider: { id: "anthropic", name: "Anthropic", isCustom: false },
      apps: {
        claude: {
          baseUrl: "https://api.anthropic.com",
          apiKeyField: "ANTHROPIC_API_KEY",
          needsProxy: false,
          enabled: true,
        },
        codex: null,
        gemini: null,
      },
    });
    const [claude] = buildQuickAddProviders(r, defaultSelection(r));
    const env = (claude.provider.settingsConfig as any).env;
    expect(env.ANTHROPIC_API_KEY).toBe(r.apiKey);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(claude.provider.meta?.apiKeyField).toBe("ANTHROPIC_API_KEY");
  });
});

describe("apps without a suggested model", () => {
  it("are offered unchecked with empty models and block saving until filled", () => {
    const r = result({
      models: [],
      totalModels: 0,
      suggested: { claude: null, codex: null, gemini: null },
    });
    const sel = defaultSelection(r);
    expect(sel.claude).toEqual({
      enabled: false,
      slots: { main: "", opus: "", sonnet: "", haiku: "" },
    });
    expect(sel.codex).toEqual({ enabled: false, model: "" });
    expect(appsMissingModel(sel)).toEqual([]);

    const typed = { ...sel, codex: { enabled: true, model: "" } };
    expect(appsMissingModel(typed)).toEqual(["codex"]);
    typed.codex.model = "glm-5.1";
    expect(appsMissingModel(typed)).toEqual([]);
    const [codex] = buildQuickAddProviders(r, typed);
    expect((codex.provider.settingsConfig as any).config).toMatch(
      /^model = "glm-5.1"$/m,
    );
  });
});

describe("global paste detection", () => {
  it("recognises keys and ignores prose", () => {
    expect(looksLikeKeyPaste("sk-3f9c2a7e1b4d48e6a0c5f7d2e9b81a64")).toBe(true);
    expect(looksLikeKeyPaste("hello world")).toBe(false);
    expect(looksLikeKeyPaste("a normal sentence without any keys in it")).toBe(
      false,
    );
  });
});
