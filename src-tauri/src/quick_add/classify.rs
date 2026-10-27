//! 模型分配：过滤掉非对话模型，按名称把模型放进各应用的槽位。
//!
//! 只做名称启发式；前端在上游预设的默认模型也在列表里时会优先用预设值。

use serde::Serialize;

/// 名称里出现这些片段的不是对话模型
const NON_CHAT_MARKERS: &[&str] = &[
    "embed",
    "embedding",
    "rerank",
    "tts",
    "whisper",
    "audio",
    "speech",
    "transcribe",
    "dall-e",
    "image",
    "imagen",
    "moderation",
    "realtime",
    "ocr",
    "veo",
    "sora",
    "seedream",
    "seedance",
    "video",
    "bge-",
    "-asr",
];

const FAST_MARKERS: &[&str] = &[
    "haiku", "flash", "mini", "lite", "nano", "air", "turbo", "small", "fast", "instant", "8b",
];
const STRONG_MARKERS: &[&str] = &[
    "opus", "pro", "max", "ultra", "large", "plus", "reasoner", "thinking",
];

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSlots {
    pub main: String,
    pub opus: String,
    pub sonnet: String,
    pub haiku: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestions {
    pub claude: Option<ClaudeSlots>,
    pub codex: Option<String>,
    pub gemini: Option<String>,
}

pub fn is_chat_model(id: &str) -> bool {
    let lower = id.to_ascii_lowercase();
    !NON_CHAT_MARKERS.iter().any(|m| lower.contains(m))
}

/// 去重、去掉非对话模型，保留原顺序
pub fn chat_models(ids: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        let id = id.trim();
        if !id.is_empty() && is_chat_model(id) && !out.iter().any(|x| x == id) {
            out.push(id.to_string());
        }
    }
    out
}

/// 名称里的版本号，按数字段比较（`glm-5.1` → [5,1]，`gpt-4o` → [4]）
fn version_of(id: &str) -> Vec<u32> {
    let lower = id.to_ascii_lowercase();
    // 日期快照（8 位数字）和参数量（`70b`）不算版本
    let mut best: Vec<u32> = Vec::new();
    let mut current = String::new();
    let flush = |current: &mut String, best: &mut Vec<u32>| {
        if !current.is_empty() {
            let parts: Vec<u32> = current
                .split('.')
                .filter(|s| !s.is_empty() && s.len() <= 4)
                .filter_map(|s| s.parse().ok())
                .collect();
            if !parts.is_empty() && parts > *best {
                *best = parts;
            }
            current.clear();
        }
    };
    let chars: Vec<char> = lower.chars().collect();
    for (i, c) in chars.iter().enumerate() {
        if c.is_ascii_digit() || (*c == '.' && !current.is_empty()) {
            current.push(*c);
        } else {
            let is_param_size = *c == 'b' && !current.is_empty();
            if is_param_size {
                current.clear();
            } else {
                flush(&mut current, &mut best);
            }
        }
        if i == chars.len() - 1 {
            flush(&mut current, &mut best);
        }
    }
    best
}

fn has_any(id: &str, markers: &[&str]) -> bool {
    // "gemini" 里含 "mini"，先换掉以免整个 Gemini 系列都被当成快模型
    let lower = id.to_ascii_lowercase().replace("gemini", "gem");
    markers.iter().any(|m| lower.contains(m))
}

fn penalty(id: &str) -> u8 {
    let lower = id.to_ascii_lowercase();
    let mut p = 0;
    for bad in [
        "preview",
        "exp",
        "beta",
        "test",
        "deprecated",
        "old",
        "legacy",
    ] {
        if lower.contains(bad) {
            p += 1;
        }
    }
    p
}

/// 在 `pool` 里挑最好的一个：版本最高，其次不是预览版，其次名字最短（别名优先于日期快照）
fn best<'a>(pool: impl Iterator<Item = &'a String>) -> Option<String> {
    pool.max_by(|a, b| {
        version_of(a)
            .cmp(&version_of(b))
            .then_with(|| penalty(b).cmp(&penalty(a)))
            .then_with(|| b.len().cmp(&a.len()))
            .then_with(|| b.cmp(a))
    })
    .cloned()
}

fn best_with(models: &[String], family: &str, markers: &[&str]) -> Option<String> {
    best(models.iter().filter(|m| {
        let l = m.to_ascii_lowercase();
        l.contains(family) && markers.iter().any(|k| l.contains(k))
    }))
}

fn best_in_family(models: &[String], family: &str) -> Option<String> {
    best(
        models
            .iter()
            .filter(|m| m.to_ascii_lowercase().contains(family)),
    )
}

/// 通用分配：强模型、普通模型、快模型
fn tiers(models: &[String]) -> (String, String, String) {
    let strong = best(
        models
            .iter()
            .filter(|m| has_any(m, STRONG_MARKERS) && !has_any(m, FAST_MARKERS)),
    );
    let normal = best(models.iter().filter(|m| !has_any(m, FAST_MARKERS)));
    let fast = best(models.iter().filter(|m| has_any(m, FAST_MARKERS)));
    let any = best(models.iter()).unwrap_or_default();
    let normal = normal.unwrap_or_else(|| any.clone());
    let strong = strong.unwrap_or_else(|| normal.clone());
    let fast = fast.unwrap_or_else(|| normal.clone());
    (strong, normal, fast)
}

pub fn suggest(models: &[String]) -> Suggestions {
    let models = chat_models(models);
    if models.is_empty() {
        return Suggestions::default();
    }

    // Claude Code：有 claude 系列（中转站）就按 opus/sonnet/haiku 对号入座
    let claude = if models
        .iter()
        .any(|m| m.to_ascii_lowercase().contains("claude"))
    {
        let sonnet = best_with(&models, "claude", &["sonnet"])
            .or_else(|| best_in_family(&models, "claude"))
            .unwrap_or_default();
        let opus = best_with(&models, "claude", &["opus"]).unwrap_or_else(|| sonnet.clone());
        let haiku = best_with(&models, "claude", &["haiku"]).unwrap_or_else(|| sonnet.clone());
        ClaudeSlots {
            main: sonnet.clone(),
            opus,
            sonnet,
            haiku,
        }
    } else {
        let (strong, _normal, fast) = tiers(&models);
        ClaudeSlots {
            main: strong.clone(),
            opus: strong.clone(),
            sonnet: strong,
            haiku: fast,
        }
    };

    let codex = best_with(&models, "gpt", &["codex"])
        .or_else(|| {
            best(models.iter().filter(|m| {
                let l = m.to_ascii_lowercase();
                l.starts_with("gpt-") && !has_any(&l, FAST_MARKERS)
            }))
        })
        .or_else(|| {
            // 没有 gpt 系列时用强模型，但跳过 claude/gemini（它们在 OpenAI 协议下不一定可用）
            let others: Vec<String> = models
                .iter()
                .filter(|m| {
                    let l = m.to_ascii_lowercase();
                    !l.contains("claude") && !l.contains("gemini")
                })
                .cloned()
                .collect();
            if others.is_empty() {
                None
            } else {
                Some(tiers(&others).0)
            }
        });

    let gemini =
        best_with(&models, "gemini", &["pro"]).or_else(|| best_in_family(&models, "gemini"));

    Suggestions {
        claude: Some(claude),
        codex,
        gemini,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn filters_non_chat_models() {
        let got = chat_models(&v(&[
            "deepseek-chat",
            "text-embedding-3",
            "tts-1",
            "deepseek-chat",
            "bge-m3",
        ]));
        assert_eq!(got, ["deepseek-chat"]);
    }

    #[test]
    fn version_parsing() {
        assert_eq!(version_of("glm-5.1"), vec![5, 1]);
        assert_eq!(version_of("qwen3-coder-30b"), vec![3]);
        assert!(version_of("glm-5.1") > version_of("glm-4.6v"));
        assert_eq!(version_of("claude-haiku-4-5-20251001"), vec![5]);
    }

    #[test]
    fn vendor_models_get_tiers() {
        let s = suggest(&v(&[
            "deepseek-v4-pro",
            "deepseek-v4-flash",
            "deepseek-chat",
        ]));
        let c = s.claude.unwrap();
        assert_eq!(c.opus, "deepseek-v4-pro");
        assert_eq!(c.main, "deepseek-v4-pro");
        assert_eq!(c.haiku, "deepseek-v4-flash");
        assert_eq!(s.codex.as_deref(), Some("deepseek-v4-pro"));
        assert_eq!(s.gemini, None);
    }

    #[test]
    fn glm_prefers_newest() {
        let s = suggest(&v(&["glm-4.6v", "glm-5.1", "glm-5-air"]));
        let c = s.claude.unwrap();
        assert_eq!(c.main, "glm-5.1");
        assert_eq!(c.haiku, "glm-5-air");
    }

    #[test]
    fn relay_with_claude_gpt_gemini() {
        let s = suggest(&v(&[
            "claude-opus-5",
            "claude-sonnet-5",
            "claude-sonnet-4-5-20250929",
            "claude-haiku-4-5",
            "gpt-5.6-sol",
            "gpt-5-mini",
            "gemini-3.6-pro",
            "gemini-3.6-flash",
            "text-embedding-3-large",
        ]));
        let c = s.claude.unwrap();
        assert_eq!(c.opus, "claude-opus-5");
        assert_eq!(c.sonnet, "claude-sonnet-5");
        assert_eq!(c.haiku, "claude-haiku-4-5");
        assert_eq!(c.main, "claude-sonnet-5");
        assert_eq!(s.codex.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(s.gemini.as_deref(), Some("gemini-3.6-pro"));
    }

    #[test]
    fn single_model_fills_every_slot() {
        let s = suggest(&v(&["kimi-k2.7-code"]));
        let c = s.claude.unwrap();
        assert_eq!(c.main, "kimi-k2.7-code");
        assert_eq!(c.haiku, "kimi-k2.7-code");
        assert_eq!(s.codex.as_deref(), Some("kimi-k2.7-code"));
    }

    #[test]
    fn empty_list() {
        assert_eq!(suggest(&[]), Suggestions::default());
    }
}
