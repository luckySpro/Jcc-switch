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
