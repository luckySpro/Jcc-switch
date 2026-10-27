//! 识别规则表：内置 `resources/key_rules.json`，用户可在数据目录放同格式的
//! `key_rules.json` 覆盖（同 id 替换，`disabled: true` 停用）。

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

use super::parse::{host_of, ParsedPaste};

const BUILTIN_RULES: &str = include_str!("../../resources/key_rules.json");
pub const USER_RULES_FILE: &str = "key_rules.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsEndpoint {
    pub base_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models_url: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
}

/// 某个应用的写入方式
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppTarget {
    /// 对应上游预设的名称；前端按它取预设模板，找不到时用通用模板
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_field: Option<String>,
    /// 协议需本地代理转换才能用（默认不勾选）
    #[serde(default)]
    pub needs_proxy: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppTargets {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude: Option<AppTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex: Option<AppTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gemini: Option<AppTarget>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRule {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub icon_color: Option<String>,
    #[serde(default)]
    pub website_url: Option<String>,
    #[serde(default)]
    pub key_patterns: Vec<String>,
    pub confidence: Confidence,
    #[serde(default)]
    pub hosts: Vec<String>,
    pub models: ModelsEndpoint,
    #[serde(default)]
    pub apps: AppTargets,
    #[serde(default)]
    pub disabled: bool,
}

#[derive(Debug, Deserialize)]
struct RulesFile {
    providers: Vec<ProviderRule>,
}

/// 编译后的规则表
pub struct RuleSet {
    rules: Vec<(ProviderRule, Vec<Regex>)>,
}

static BUILTIN: Lazy<Vec<ProviderRule>> = Lazy::new(|| {
    serde_json::from_str::<RulesFile>(BUILTIN_RULES)
        .expect("built-in key_rules.json must be valid")
        .providers
});

pub fn builtin_rules() -> Vec<ProviderRule> {
    BUILTIN.clone()
}

impl RuleSet {
    pub fn new(rules: Vec<ProviderRule>) -> Result<Self, String> {
        let mut compiled = Vec::with_capacity(rules.len());
        for rule in rules.into_iter().filter(|r| !r.disabled) {
            let mut patterns = Vec::with_capacity(rule.key_patterns.len());
            for p in &rule.key_patterns {
                patterns
                    .push(Regex::new(p).map_err(|e| format!("规则 {} 的正则无效：{e}", rule.id))?);
            }
            compiled.push((rule, patterns));
        }
        Ok(Self { rules: compiled })
    }

    /// 内置规则 + `dir/key_rules.json` 里的用户规则
    pub fn load(dir: &Path) -> Result<Self, String> {
        let mut rules = builtin_rules();
        let path = dir.join(USER_RULES_FILE);
        if path.is_file() {
            let text = std::fs::read_to_string(&path)
                .map_err(|e| format!("读取 {} 失败：{e}", path.display()))?;
            let user: RulesFile = serde_json::from_str(&text)
                .map_err(|e| format!("{} 格式错误：{e}", path.display()))?;
            rules = merge_rules(rules, user.providers);
        }
        Self::new(rules)
    }

    pub fn get(&self, id: &str) -> Option<&ProviderRule> {
        self.rules.iter().find(|(r, _)| r.id == id).map(|(r, _)| r)
    }

    /// 根据粘贴内容给出要探测的候选。
    ///
    /// - 粘贴里带地址：主机命中已知供应商就用该供应商，否则当作兼容中转站（`custom`）。
    /// - 只有 Key：按 Key 格式匹配；最高置信度为 high 时只留 high 的候选。
    pub fn candidates(&self, parsed: &ParsedPaste) -> Vec<Candidate> {
        if let Some(base) = &parsed.base_url {
            let host = host_of(base);
            if let Some((rule, _)) = self.rules.iter().find(|(r, _)| {
                host.as_ref()
                    .is_some_and(|h| r.hosts.iter().any(|x| x == h))
            }) {
                return vec![Candidate::from_rule(rule, Confidence::High)];
            }
            return vec![Candidate::custom(base)];
        }

        let Some(key) = parsed.api_key.as_deref() else {
            return Vec::new();
        };
        let mut matched: Vec<Candidate> = self
            .rules
            .iter()
            .filter(|(_, pats)| pats.iter().any(|p| p.is_match(key)))
            .map(|(r, _)| Candidate::from_rule(r, r.confidence))
            .collect();
        if matched.iter().any(|c| c.confidence == Confidence::High) {
            matched.retain(|c| c.confidence == Confidence::High);
        }
        matched
    }
}

/// 用户规则合并进内置规则：同 id 替换，新 id 追加
pub fn merge_rules(mut base: Vec<ProviderRule>, user: Vec<ProviderRule>) -> Vec<ProviderRule> {
    for rule in user {
        if let Some(slot) = base.iter_mut().find(|r| r.id == rule.id) {
            *slot = rule;
        } else {
            base.push(rule);
        }
    }
    base
}

/// 一次探测目标
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    /// 规则 id；中转站为 `custom`
    pub id: String,
    pub name: String,
    pub host: String,
    pub confidence: Confidence,
    #[serde(skip)]
    pub models: ModelsEndpoint,
}

pub const CUSTOM_ID: &str = "custom";

impl Candidate {
    fn from_rule(rule: &ProviderRule, confidence: Confidence) -> Self {
        Self {
            id: rule.id.clone(),
            name: rule.name.clone(),
            host: host_of(&rule.models.base_url).unwrap_or_default(),
            confidence,
            models: rule.models.clone(),
        }
    }

    fn custom(base_url: &str) -> Self {
        let host = host_of(base_url).unwrap_or_else(|| base_url.to_string());
        Self {
            id: CUSTOM_ID.to_string(),
            name: host.clone(),
            host,
            confidence: Confidence::High,
            models: ModelsEndpoint {
                base_url: base_url.to_string(),
                ..Default::default()
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quick_add::parse::parse_paste;

    fn set() -> RuleSet {
        RuleSet::new(builtin_rules()).unwrap()
    }

    fn ids(text: &str) -> Vec<String> {
        set()
            .candidates(&parse_paste(text))
            .into_iter()
            .map(|c| c.id)
            .collect()
    }

    #[test]
    fn builtin_rules_compile() {
        assert!(builtin_rules().len() >= 10);
        set();
    }

    #[test]
    fn high_confidence_prefixes() {
        assert_eq!(
            ids(&format!("sk-ant-api03-{}", "a".repeat(90))),
            ["anthropic"]
        );
        assert_eq!(ids(&format!("sk-proj-{}", "Ab1".repeat(20))), ["openai"]);
        assert_eq!(
            ids(&format!("sk-or-v1-{}", "0f".repeat(32))),
            ["openrouter"]
        );
        assert_eq!(ids("AIzaSyD4x7Lq2vNw8Ke3Rt6Yp0Uh5Jm9Bc1Fg2Q"), ["gemini"]);
        assert_eq!(ids(&format!("xai-{}", "Ab1".repeat(20))), ["xai"]);
        assert_eq!(ids(&format!("gsk_{}", "Ab1".repeat(20))), ["groq"]);
    }

    #[test]
    fn ambiguous_sk_key_probes_several() {
        let got = ids("sk-3f9c2a7e1b4d48e6a0c5f7d2e9b81a64");
        assert_eq!(got, ["deepseek", "dashscope"]);
        let got = ids(&format!("sk-{}", "abcdefgh".repeat(6)));
        assert!(got.contains(&"moonshot".to_string()));
        assert!(got.contains(&"siliconflow".to_string()));
    }

    #[test]
    fn zhipu_and_volcengine() {
        assert_eq!(
            ids("8c1f4e2a9b7d4c3e8f0a1b2c3d4e5f60.Ab3dEf7GhJk9LmNp"),
            ["zhipu", "zai"]
        );
        assert_eq!(ids("3b2f6c1a-9d4e-4f7a-8b2c-1e5d6f7a8b9c"), ["volcengine"]);
    }

    #[test]
    fn pasted_url_wins() {
        // 已知主机 → 该供应商
        assert_eq!(
            ids("https://api.deepseek.com/anthropic\nsk-3f9c2a7e1b4d48e6a0c5f7d2e9b81a64"),
            ["deepseek"]
        );
        // 未知主机 → 兼容中转站，哪怕 Key 像某家官方
        let c = set().candidates(&parse_paste(
            "https://relay.example.com/v1 sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa",
        ));
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].id, CUSTOM_ID);
        assert_eq!(c[0].models.base_url, "https://relay.example.com/v1");
    }

    #[test]
    fn unknown_key_has_no_candidates() {
        assert!(ids("totally-unknown-format-1234567890").is_empty());
    }

    #[test]
    fn user_rules_replace_and_disable() {
        let mut deepseek = builtin_rules()
            .into_iter()
            .find(|r| r.id == "deepseek")
            .unwrap();
        deepseek.disabled = true;
        let merged = merge_rules(builtin_rules(), vec![deepseek]);
        let set = RuleSet::new(merged).unwrap();
        let got: Vec<_> = set
            .candidates(&parse_paste("sk-3f9c2a7e1b4d48e6a0c5f7d2e9b81a64"))
            .into_iter()
            .map(|c| c.id)
            .collect();
        assert_eq!(got, ["dashscope"]);
    }

    #[test]
    fn invalid_user_regex_is_reported() {
        let mut bad = builtin_rules()[0].clone();
        bad.key_patterns = vec!["(".into()];
        assert!(RuleSet::new(vec![bad]).is_err());
    }
}
