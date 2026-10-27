//! 粘贴内容解析：从裸 Key、环境变量块、JSON、curl 命令或「地址 + Key」文本里
//! 取出 API Key 与 Base URL。纯函数，不做网络请求。

use once_cell::sync::Lazy;
use regex::Regex;

/// 解析结果
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedPaste {
    pub api_key: Option<String>,
    /// 用户粘贴里带的地址，已去掉 `/chat/completions` 这类具体接口路径
    pub base_url: Option<String>,
    /// 粘贴开头的标题行，如「gpt官转：」，用作中转站的默认名称
    pub label: Option<String>,
}

static URL_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"https?://[^\s"'<>`,;]+"#).unwrap());

/// 形如 `NAME=value`、`"name": "value"`、`name = "value"` 的赋值，名字里带 key/token
static ASSIGN_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"(?i)["']?([A-Za-z_][A-Za-z0-9_]*(?:key|token)[A-Za-z0-9_]*)["']?\s*[:=]\s*["']?([^\s"',;}]+)"#,
    )
    .unwrap()
});

/// HTTP 头里的 Key：`Authorization: Bearer xxx`、`x-api-key: xxx`、`x-goog-api-key: xxx`
static HEADER_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"(?i)(?:authorization\s*:\s*bearer\s+|x-api-key\s*:\s*|x-goog-api-key\s*:\s*)([^\s"']+)"#,
    )
    .unwrap()
});

static TOKEN_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[A-Za-z0-9][A-Za-z0-9._-]{15,}").unwrap());

/// 具体接口路径后缀；粘贴的是完整接口地址时剥掉，保留到版本段为止
const ENDPOINT_SUFFIXES: &[&str] = &[
    "/chat/completions",
    "/completions",
    "/responses",
    "/messages",
    "/models",
    "/embeddings",
];

pub fn parse_paste(text: &str) -> ParsedPaste {
    let base_url = URL_RE
        .find_iter(text)
        .map(|m| normalize_base_url(m.as_str()))
        .find(|u| !u.is_empty());

    let api_key = find_key(text);
    let label = find_label(text, api_key.as_deref());
    ParsedPaste {
        api_key,
        base_url,
        label,
    }
}

/// 第一行非空内容若只是个短标题（不含地址、Key 或赋值），就当作名称
fn find_label(text: &str, key: Option<&str>) -> Option<String> {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    let label = line.trim_end_matches([':', '：']).trim();
    let is_title = !label.is_empty()
        && label.chars().count() <= 32
        && !URL_RE.is_match(label)
        && key.is_none_or(|k| !label.contains(k))
        && !label.contains(['=', ':', '：', '{', '"']);
    is_title.then(|| label.to_string())
}

fn find_key(text: &str) -> Option<String> {
    if let Some(c) = HEADER_RE.captures(text) {
        return Some(c[1].to_string());
    }
    for c in ASSIGN_RE.captures_iter(text) {
        let value = &c[2];
        if !value.starts_with("http") && value.len() >= 8 {
            return Some(value.to_string());
        }
    }
    // URL 查询参数里的 key=...（Gemini 常见）
    for m in URL_RE.find_iter(text) {
        if let Ok(url) = url::Url::parse(m.as_str()) {
            if let Some((_, v)) = url.query_pairs().find(|(k, _)| k == "key") {
                if v.len() >= 8 {
                    return Some(v.into_owned());
                }
            }
        }
    }
    // 去掉 URL 后取最长的类 Key 片段
    let without_urls = URL_RE.replace_all(text, " ");
    TOKEN_RE
        .find_iter(&without_urls)
        .map(|m| m.as_str().trim_end_matches(['.', '-']))
        .filter(|t| looks_like_key(t))
        .max_by_key(|t| t.len())
        .map(str::to_string)
}

fn looks_like_key(token: &str) -> bool {
    // 没有数字或连字符的长单词、全大写的环境变量名都不算 Key
    token.len() >= 16
        && token
            .chars()
            .any(|c| c.is_ascii_digit() || c == '-' || c == '_')
        && !token
            .chars()
            .all(|c| c.is_ascii_uppercase() || c == '_' || c.is_ascii_digit())
}

pub fn normalize_base_url(raw: &str) -> String {
    let mut url = raw
        .trim()
        .trim_end_matches(['.', ')', ']', '/'])
        .to_string();
    if let Some(idx) = url.find('?') {
        url.truncate(idx);
    }
    // Gemini 原生接口：.../v1beta/models/gemini-x:generateContent → 根地址
    if let Some(idx) = url.find("/v1beta/") {
        url.truncate(idx);
    }
    loop {
        let before = url.len();
        for suffix in ENDPOINT_SUFFIXES {
            if let Some(stripped) = url.strip_suffix(suffix) {
                url = stripped.to_string();
            }
        }
        if url.len() == before {
            break;
        }
    }
    url.trim_end_matches('/').to_string()
}

/// 取 URL 的主机名（小写，不含端口）
pub fn host_of(url: &str) -> Option<String> {
    url::Url::parse(url)
        .ok()?
        .host_str()
        .map(|h| h.to_ascii_lowercase())
}

/// 屏蔽显示：保留前 6 位与后 4 位
pub fn mask_key(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    if chars.len() <= 12 {
        return "•".repeat(chars.len());
    }
    let head: String = chars[..6].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}…{tail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_key() {
        let p = parse_paste("  sk-3f9c2a7e1b4d48e6a0c5f7d2e9b81a64 \n");
        assert_eq!(
            p.api_key.as_deref(),
            Some("sk-3f9c2a7e1b4d48e6a0c5f7d2e9b81a64")
        );
        assert_eq!(p.base_url, None);
    }

    #[test]
    fn url_and_key_lines() {
        let p = parse_paste("https://api.my-relay.example/v1\nsk-relay7Hk2abcdefghij1234");
        assert_eq!(
            p.base_url.as_deref(),
            Some("https://api.my-relay.example/v1")
        );
        assert_eq!(p.api_key.as_deref(), Some("sk-relay7Hk2abcdefghij1234"));
    }

    #[test]
    fn labelled_chinese_lines() {
        // 中转站常见的发 Key 格式：带标题、全角冒号
        let p = parse_paste(
            "gpt官转：\nurl：https://relay.example.com\n秘钥：sk-0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a6978\n",
        );
        assert_eq!(p.base_url.as_deref(), Some("https://relay.example.com"));
        assert_eq!(
            p.api_key.as_deref(),
            Some("sk-0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a6978")
        );
        assert_eq!(p.label.as_deref(), Some("gpt官转"));
    }

    #[test]
    fn no_label_without_a_title_line() {
        assert_eq!(
            parse_paste("sk-3f9c2a7e1b4d48e6a0c5f7d2e9b81a64").label,
            None
        );
        assert_eq!(
            parse_paste("url：https://relay.example.com\nsk-3f9c2a7e1b4d48e6a0c5f7d2e9b81a64")
                .label,
            None
        );
        assert_eq!(
            parse_paste("export OPENAI_API_KEY=sk-abc123def456ghi789").label,
            None
        );
    }

    #[test]
    fn env_block() {
        let text = "export ANTHROPIC_BASE_URL=https://relay.example.com/\nexport ANTHROPIC_AUTH_TOKEN=sk-abc123def456ghi789\n";
        let p = parse_paste(text);
        assert_eq!(p.base_url.as_deref(), Some("https://relay.example.com"));
        assert_eq!(p.api_key.as_deref(), Some("sk-abc123def456ghi789"));
    }

    #[test]
    fn json_config() {
        let text = r#"{"env":{"ANTHROPIC_BASE_URL":"https://x.example/api","ANTHROPIC_AUTH_TOKEN":"tok-1234567890abcd"}}"#;
        let p = parse_paste(text);
        assert_eq!(p.base_url.as_deref(), Some("https://x.example/api"));
        assert_eq!(p.api_key.as_deref(), Some("tok-1234567890abcd"));
    }

    #[test]
    fn curl_command() {
        let text = r#"curl https://api.relay.example/v1/chat/completions -H "Authorization: Bearer sk-curl0123456789abcdef" -d '{}'"#;
        let p = parse_paste(text);
        assert_eq!(p.base_url.as_deref(), Some("https://api.relay.example/v1"));
        assert_eq!(p.api_key.as_deref(), Some("sk-curl0123456789abcdef"));
    }

    #[test]
    fn gemini_url_with_key_param() {
        let text = "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=AIzaSyD4x7Lq2vNw8Ke3Rt6Yp0Uh5Jm9Bc1Fg2Q";
        let p = parse_paste(text);
        assert_eq!(
            p.base_url.as_deref(),
            Some("https://generativelanguage.googleapis.com")
        );
        assert_eq!(
            p.api_key.as_deref(),
            Some("AIzaSyD4x7Lq2vNw8Ke3Rt6Yp0Uh5Jm9Bc1Fg2Q")
        );
    }

    #[test]
    fn zhipu_key_with_dot() {
        let p = parse_paste("8c1f4e2a9b7d4c3e8f0a1b2c3d4e5f60.Ab3dEf7GhJk9LmNp");
        assert_eq!(
            p.api_key.as_deref(),
            Some("8c1f4e2a9b7d4c3e8f0a1b2c3d4e5f60.Ab3dEf7GhJk9LmNp")
        );
    }

    #[test]
    fn masks_key() {
        assert_eq!(mask_key("sk-3f9c2a7e1b4d48e6a0c5"), "sk-3f9…a0c5");
        assert_eq!(mask_key("short"), "•••••");
    }

    #[test]
    fn empty_input() {
        assert_eq!(parse_paste("   "), ParsedPaste::default());
    }
}
