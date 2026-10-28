//! 一键贴 Key 命令

use tauri::ipc::Channel;

use crate::quick_add::{
    self,
    probe::ProbeEvent,
    rules::{Candidate, RuleSet},
    DetectResult, PastePreview,
};
use crate::services::model_fetch;

fn load_rules() -> Result<RuleSet, String> {
    RuleSet::load(&crate::config::get_app_config_dir())
}

/// 不联网：解析粘贴内容，列出将要探测的供应商与域名
#[tauri::command]
pub fn quick_add_preview(text: String) -> Result<PastePreview, String> {
    Ok(quick_add::preview(&text, &load_rules()?))
}

/// 探测供应商并拉取模型；进度经 `on_event` 逐条推送
#[tauri::command]
pub async fn quick_add_detect(
    text: String,
    on_event: Channel<ProbeEvent>,
) -> Result<DetectResult, String> {
    let rules = load_rules()?;
    quick_add::detect(&text, &rules, fetch_candidate_models, |e| {
        let _ = on_event.send(e);
    })
    .await
}

async fn fetch_candidate_models(candidate: Candidate, key: String) -> Result<Vec<String>, String> {
    let m = &candidate.models;
    let headers = (!m.headers.is_empty()).then_some(&m.headers);
    let models = model_fetch::fetch_models(
        &m.base_url,
        &key,
        false,
        m.models_url.as_deref(),
        None,
        m.api_format.as_deref(),
        headers,
    )
    .await?;
    Ok(models.into_iter().map(|m| m.id).collect())
}

/// 中转站是否支持 OpenAI Responses 接口（Grok Build 只走这个协议）。
/// 发一个空请求体：接口存在时会因参数缺失返回 4xx 校验错误，不存在时返回 404/405，
/// 这样不会真的调用模型、不产生费用。
#[tauri::command]
pub async fn quick_add_probe_responses(base_url: String, api_key: String) -> Result<bool, String> {
    let url = format!("{}/responses", base_url.trim_end_matches('/'));
    let response = crate::proxy::http_client::get_for_url(&url)
        .post(&url)
        .bearer_auth(api_key.trim())
        .header("content-type", "application/json")
        .body("{}")
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    Ok(responses_supported(status, &body))
}

fn responses_supported(status: u16, body: &str) -> bool {
    match status {
        404 | 405 | 501 => false,
        // 有的网关对未知路径也回 400，但会在消息里说明路由不存在
        400..=499 => {
            let lower = body.to_ascii_lowercase();
            ![
                "not found",
                "no route",
                "invalid url",
                "unsupported",
                "not supported",
            ]
            .iter()
            .any(|m| lower.contains(m))
        }
        200..=299 => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::responses_supported;

    #[test]
    fn classifies_responses_probe() {
        assert!(responses_supported(
            400,
            r#"{"error":{"message":"model is required"}}"#
        ));
        assert!(responses_supported(422, "missing field `input`"));
        assert!(!responses_supported(404, "Not Found"));
        assert!(!responses_supported(
            400,
            "Invalid URL (POST /v1/responses)"
        ));
        assert!(!responses_supported(500, ""));
    }
}
