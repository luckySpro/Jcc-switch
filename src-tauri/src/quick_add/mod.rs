//! 一键贴 Key：从粘贴内容认出供应商、拉取模型并给出各应用的写入方案。
//!
//! 写入本身在前端完成：前端按方案套用上游预设，再走原有的「添加 + 启用」流程，
//! 这样原子写入、备份和字段合并都沿用上游实现。

pub mod classify;
pub mod parse;
pub mod probe;
pub mod rules;

use serde::Serialize;
use std::future::Future;

use classify::{suggest, ClaudeSlots};
use parse::{mask_key, parse_paste, ParsedPaste};
use probe::{probe_candidates, ProbeEvent, ProbeHit};
use rules::{AppTarget, Candidate, RuleSet, CUSTOM_ID};

/// 不联网的预览：Key、地址和将要探测的域名，供界面在探测前展示
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PastePreview {
    pub key_masked: Option<String>,
    pub base_url: Option<String>,
    pub candidates: Vec<Candidate>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedProvider {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub icon_color: Option<String>,
    pub website_url: Option<String>,
    pub is_custom: bool,
}

/// 某个应用的写入方案
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPlan {
    #[serde(flatten)]
    pub target: AppTarget,
    /// 界面上默认是否勾选
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPlans {
    pub claude: Option<AppPlan>,
    pub codex: Option<AppPlan>,
    pub gemini: Option<AppPlan>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggested {
    pub claude: Option<ClaudeSlots>,
    pub codex: Option<String>,
    pub gemini: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectResult {
    pub provider: DetectedProvider,
    pub api_key: String,
    pub key_masked: String,
    pub models_base_url: String,
    pub latency_ms: u64,
    /// 已过滤掉非对话模型
    pub models: Vec<String>,
    pub total_models: usize,
    pub apps: AppPlans,
    pub suggested: Suggested,
}

pub fn preview(text: &str, rules: &RuleSet) -> PastePreview {
    let parsed = parse_paste(text);
    PastePreview {
        key_masked: parsed.api_key.as_deref().map(mask_key),
        base_url: parsed.base_url.clone(),
        candidates: rules.candidates(&parsed),
    }
}

pub async fn detect<F, Fut>(
    text: &str,
    rules: &RuleSet,
    fetch: F,
    on_event: impl FnMut(ProbeEvent),
) -> Result<DetectResult, String>
where
    F: Fn(Candidate, String) -> Fut,
    Fut: Future<Output = Result<Vec<String>, String>>,
{
    let parsed = parse_paste(text);
    let key = parsed
        .api_key
        .clone()
        .ok_or_else(|| "没有在粘贴内容里找到 API Key".to_string())?;
    let candidates = rules.candidates(&parsed);
    if candidates.is_empty() {
        return Err("认不出这个 Key 属于哪家，请连同接口地址一起粘贴".to_string());
    }
    let hit = probe_candidates(candidates, |c| fetch(c, key.clone()), on_event).await?;
    Ok(build_result(&parsed, key, hit, rules))
}

fn build_result(parsed: &ParsedPaste, key: String, hit: ProbeHit, rules: &RuleSet) -> DetectResult {
    let total_models = hit.models.len();
    let models = classify::chat_models(&hit.models);
    let s = suggest(&models);

    let (provider, apps) = if hit.candidate.id == CUSTOM_ID {
        let base = hit.candidate.models.base_url.clone();
        (
            DetectedProvider {
                id: CUSTOM_ID.to_string(),
                name: parsed
                    .label
                    .clone()
                    .unwrap_or_else(|| hit.candidate.name.clone()),
                icon: None,
                icon_color: None,
                website_url: None,
                is_custom: true,
            },
            custom_app_plans(&base, s.gemini.is_some()),
        )
    } else {
        let rule = rules
            .get(&hit.candidate.id)
            .expect("hit candidate comes from the rule set");
        let plan = |t: &Option<AppTarget>| {
            t.clone().map(|target| AppPlan {
                enabled: !target.needs_proxy,
                target,
            })
        };
        let mut apps = AppPlans {
            claude: plan(&rule.apps.claude),
            codex: plan(&rule.apps.codex),
            gemini: plan(&rule.apps.gemini),
        };
        // 粘贴里带了该供应商的地址时，以粘贴的为准写给协议相符的应用
        if let Some(base) = &parsed.base_url {
            override_with_pasted(&mut apps, base);
        }
        (
            DetectedProvider {
                id: rule.id.clone(),
                name: rule.name.clone(),
                icon: rule.icon.clone(),
                icon_color: rule.icon_color.clone(),
                website_url: rule.website_url.clone(),
                is_custom: false,
            },
            apps,
        )
    };

    DetectResult {
        provider,
        key_masked: mask_key(&key),
        api_key: key,
        models_base_url: hit.candidate.models.base_url.clone(),
        latency_ms: hit.latency_ms,
        models,
        total_models,
        apps,
        suggested: Suggested {
            claude: s.claude,
            codex: s.codex,
            gemini: s.gemini,
        },
    }
}

fn ends_with_version(url: &str) -> bool {
    url.rsplit('/').next().is_some_and(|seg| {
        seg.len() >= 2 && seg.starts_with('v') && seg[1..].chars().all(|c| c.is_ascii_digit())
    })
}

fn strip_version(url: &str) -> String {
    if ends_with_version(url) {
        url.rsplit_once('/')
            .map(|(head, _)| head.to_string())
            .unwrap_or_default()
    } else {
        url.to_string()
    }
}

/// 兼容中转站：Anthropic / Gemini 协议用根地址，OpenAI 协议用 `/v1`
pub fn custom_app_plans(base: &str, has_gemini_models: bool) -> AppPlans {
    let root = strip_version(base);
    let openai = if ends_with_version(base) {
        base.to_string()
    } else {
        format!("{root}/v1")
    };
    let target = |url: String| AppTarget {
        base_url: Some(url),
        ..Default::default()
    };
    AppPlans {
        claude: Some(AppPlan {
            target: target(root.clone()),
            enabled: true,
        }),
        codex: Some(AppPlan {
            target: target(openai),
            enabled: true,
        }),
        gemini: Some(AppPlan {
            target: target(root),
            enabled: has_gemini_models,
        }),
    }
}

fn override_with_pasted(apps: &mut AppPlans, pasted: &str) {
    let lower = pasted.to_ascii_lowercase();
    let slot = if lower.contains("anthropic") || lower.contains("/claude") {
        &mut apps.claude
    } else if ends_with_version(pasted) {
        &mut apps.codex
    } else {
        return;
    };
    if let Some(plan) = slot {
        plan.target.base_url = Some(pasted.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rules::builtin_rules;

    fn set() -> RuleSet {
        RuleSet::new(builtin_rules()).unwrap()
    }

    #[test]
    fn custom_plans_derive_protocol_bases() {
        let p = custom_app_plans("https://relay.example/v1", false);
        assert_eq!(
            p.claude.unwrap().target.base_url.as_deref(),
            Some("https://relay.example")
        );
        assert_eq!(
            p.codex.unwrap().target.base_url.as_deref(),
            Some("https://relay.example/v1")
        );
        assert!(!p.gemini.unwrap().enabled);

        let p = custom_app_plans("https://relay.example", true);
        assert_eq!(
            p.codex.unwrap().target.base_url.as_deref(),
            Some("https://relay.example/v1")
        );
        assert!(p.gemini.unwrap().enabled);
    }

    #[tokio::test]
    async fn detect_ambiguous_key_hits_second_candidate() {
        let mut seen = Vec::new();
        let r = detect(
            "sk-3f9c2a7e1b4d48e6a0c5f7d2e9b81a64",
            &set(),
            |c, key| async move {
                assert_eq!(key, "sk-3f9c2a7e1b4d48e6a0c5f7d2e9b81a64");
                if c.id == "dashscope" {
                    Ok(vec![
                        "qwen3-max".to_string(),
                        "qwen3-flash".to_string(),
                        "text-embedding-v4".to_string(),
                    ])
                } else {
                    Err("HTTP 401 Unauthorized".to_string())
                }
            },
            |e| seen.push(e),
        )
        .await
        .unwrap();
        assert_eq!(r.provider.id, "dashscope");
        assert_eq!(r.models, ["qwen3-max", "qwen3-flash"]);
        assert_eq!(r.total_models, 3);
        assert_eq!(r.suggested.claude.as_ref().unwrap().haiku, "qwen3-flash");
        assert!(r.apps.claude.as_ref().unwrap().enabled);
        assert!(r.apps.gemini.is_none());
        assert_eq!(r.key_masked, "sk-3f9…1a64");
        assert!(!seen.is_empty());
    }

    #[tokio::test]
    async fn detect_pasted_relay_url() {
        let r = detect(
            "https://api.my-relay.example/v1\nsk-relay7Hk2abcdefghij1234",
            &set(),
            |c, _| async move {
                assert_eq!(c.models.base_url, "https://api.my-relay.example/v1");
                Ok(vec![
                    "claude-sonnet-5".to_string(),
                    "gpt-5.6-sol".to_string(),
                ])
            },
            |_| {},
        )
        .await
        .unwrap();
        assert!(r.provider.is_custom);
        assert_eq!(r.provider.name, "api.my-relay.example");
        let claude = r.apps.claude.unwrap();
        assert_eq!(
            claude.target.base_url.as_deref(),
            Some("https://api.my-relay.example")
        );
        assert_eq!(r.suggested.codex.as_deref(), Some("gpt-5.6-sol"));
        assert!(!r.apps.gemini.unwrap().enabled);
    }

    #[tokio::test]
    async fn needs_proxy_apps_start_unchecked() {
        let r = detect(
            &format!("gsk_{}", "Ab1".repeat(20)),
            &set(),
            |_, _| async { Ok(vec!["openai/gpt-oss-120b".to_string()]) },
            |_| {},
        )
        .await
        .unwrap();
        assert_eq!(r.provider.id, "groq");
        assert!(!r.apps.codex.unwrap().enabled);
    }

    #[tokio::test]
    async fn unknown_key_asks_for_url() {
        let err = detect(
            "unknown-format-1234567890abcdef",
            &set(),
            |_, _| async { Ok(vec![]) },
            |_| {},
        )
        .await
        .unwrap_err();
        assert!(err.contains("接口地址"));
    }

    #[test]
    fn preview_lists_domains_without_network() {
        let p = preview("sk-3f9c2a7e1b4d48e6a0c5f7d2e9b81a64", &set());
        let hosts: Vec<_> = p.candidates.iter().map(|c| c.host.as_str()).collect();
        assert_eq!(hosts, ["api.deepseek.com", "dashscope.aliyuncs.com"]);
    }
}
