//! 并发探测候选供应商的模型列表接口：第一个返回 200 的即为命中，其余请求取消。

use futures::stream::{FuturesUnordered, StreamExt};
use serde::Serialize;
use std::future::Future;
use std::time::{Duration, Instant};

use super::rules::Candidate;

pub const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProbeStatus {
    Probing,
    Hit,
    Rejected,
    Error,
    Cancelled,
}

/// 推给前端的进度
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeEvent {
    pub candidate_id: String,
    pub status: ProbeStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ProbeHit {
    pub candidate: Candidate,
    pub models: Vec<String>,
    pub latency_ms: u64,
}

/// 把模型拉取错误归类：401/403 说明 Key 不属于这家
pub fn classify_error(err: &str) -> ProbeStatus {
    if err.starts_with("HTTP 401") || err.starts_with("HTTP 403") {
        ProbeStatus::Rejected
    } else {
        ProbeStatus::Error
    }
}

pub async fn probe_candidates<F, Fut>(
    candidates: Vec<Candidate>,
    fetch: F,
    mut on_event: impl FnMut(ProbeEvent),
) -> Result<ProbeHit, String>
where
    F: Fn(Candidate) -> Fut,
    Fut: Future<Output = Result<Vec<String>, String>>,
{
    if candidates.is_empty() {
        return Err("没有可探测的供应商".to_string());
    }
    let mut pending: Vec<String> = candidates.iter().map(|c| c.id.clone()).collect();
    let mut tasks = FuturesUnordered::new();
    for candidate in candidates {
        on_event(ProbeEvent {
            candidate_id: candidate.id.clone(),
            status: ProbeStatus::Probing,
            latency_ms: None,
            message: None,
        });
        let fut = fetch(candidate.clone());
        tasks.push(async move {
            let start = Instant::now();
            let result = match tokio::time::timeout(PROBE_TIMEOUT, fut).await {
                Ok(r) => r,
                Err(_) => Err("超时".to_string()),
            };
            (candidate, result, start.elapsed().as_millis() as u64)
        });
    }

    let mut errors: Vec<String> = Vec::new();
    while let Some((candidate, result, latency_ms)) = tasks.next().await {
        pending.retain(|id| id != &candidate.id);
        match result {
            Ok(models) => {
                on_event(ProbeEvent {
                    candidate_id: candidate.id.clone(),
                    status: ProbeStatus::Hit,
                    latency_ms: Some(latency_ms),
                    message: Some(format!("{} 个模型", models.len())),
                });
                for id in pending {
                    on_event(ProbeEvent {
                        candidate_id: id,
                        status: ProbeStatus::Cancelled,
                        latency_ms: None,
                        message: None,
                    });
                }
                return Ok(ProbeHit {
                    candidate,
                    models,
                    latency_ms,
                });
            }
            Err(err) => {
                let status = classify_error(&err);
                errors.push(format!("{}：{}", candidate.name, short(&err)));
                on_event(ProbeEvent {
                    candidate_id: candidate.id,
                    status,
                    latency_ms: Some(latency_ms),
                    message: Some(short(&err)),
                });
            }
        }
    }
    Err(format!("没有供应商接受这个 Key（{}）", errors.join("；")))
}

fn short(err: &str) -> String {
    let s: String = err.chars().take(120).collect();
    s.replace('\n', " ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quick_add::rules::{Confidence, ModelsEndpoint};

    fn cand(id: &str) -> Candidate {
        Candidate {
            id: id.into(),
            name: id.into(),
            host: format!("{id}.example"),
            confidence: Confidence::Low,
            models: ModelsEndpoint {
                base_url: format!("https://{id}.example"),
                ..Default::default()
            },
        }
    }

    #[tokio::test]
    async fn first_success_wins_and_rest_cancelled() {
        let mut events = Vec::new();
        let hit = probe_candidates(
            vec![cand("a"), cand("b"), cand("c")],
            |c| async move {
                match c.id.as_str() {
                    "a" => Err("HTTP 401 Unauthorized: bad key".to_string()),
                    "b" => {
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        Ok(vec!["m1".to_string()])
                    }
                    _ => {
                        tokio::time::sleep(Duration::from_secs(5)).await;
                        Ok(vec![])
                    }
                }
            },
            |e| events.push(e),
        )
        .await
        .unwrap();
        assert_eq!(hit.candidate.id, "b");
        assert_eq!(hit.models, ["m1"]);
        let status = |id: &str| {
            events
                .iter()
                .rev()
                .find(|e| e.candidate_id == id)
                .unwrap()
                .status
        };
        assert_eq!(status("a"), ProbeStatus::Rejected);
        assert_eq!(status("b"), ProbeStatus::Hit);
        assert_eq!(status("c"), ProbeStatus::Cancelled);
    }

    #[tokio::test]
    async fn all_failed_reports_each() {
        let err = probe_candidates(
            vec![cand("a"), cand("b")],
            |c| async move {
                if c.id == "a" {
                    Err("HTTP 403 Forbidden".to_string())
                } else {
                    Err("Request failed: dns error".to_string())
                }
            },
            |_| {},
        )
        .await
        .unwrap_err();
        assert!(err.contains("a：HTTP 403"));
        assert!(err.contains("b：Request failed"));
    }

    #[test]
    fn error_classification() {
        assert_eq!(
            classify_error("HTTP 401 Unauthorized: x"),
            ProbeStatus::Rejected
        );
        assert_eq!(classify_error("HTTP 500: x"), ProbeStatus::Error);
    }
}
