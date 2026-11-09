use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::installer::WebuiControl;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GenerationProgress {
    indeterminate: bool,
    #[serde(skip)]
    job_id: Option<String>,
    #[serde(skip)]
    completed_jobs: u64,
    #[serde(skip)]
    interrupted: bool,
    available: bool,
    active: bool,
    percent: u8,
    eta_seconds: Option<u64>,
    preview: Option<String>,
    label: String,
}

impl GenerationProgress {
    fn idle(available: bool, label: &str) -> Self {
        Self { indeterminate: false, job_id: None, completed_jobs: 0, interrupted: false,
            available, active: false, percent: 0, eta_seconds: None,
            preview: None, label: label.to_owned() }
    }
}

fn parse_progress(value: &Value) -> GenerationProgress {
    let state = &value["state"];
    let jobs = state["job_count"].as_i64().unwrap_or(0);
    let mut status = GenerationProgress::idle(true, "Генерация не выполняется");
    status.job_id = state["job_timestamp"].as_str().filter(|id| !id.is_empty() && *id != "0")
        .map(|id| id.chars().take(64).collect());
    status.completed_jobs = state["job_no"].as_u64().unwrap_or(0);
    status.interrupted = ["interrupted", "skipped", "stopping_generation"].iter()
        .any(|key| state[*key].as_bool().unwrap_or(false));
    if jobs == 0 { return status; }
    let fraction = value["progress"].as_f64().unwrap_or(0.0).clamp(0.0, 1.0);
    let preview = value["current_image"].as_str().and_then(|image| {
        let raw = ["data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,"]
            .iter().find_map(|prefix| image.strip_prefix(prefix)).unwrap_or(image);
        let mime = if raw.starts_with("/9j/") { "jpeg" } else if raw.starts_with("UklGR") { "webp" } else { "png" };
        (raw.len() <= 2_000_000 && !raw.is_empty()
            && raw.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=')))
            .then(|| format!("data:image/{mime};base64,{raw}"))
    });
    GenerationProgress {
        available: true,
        active: true,
        percent: (fraction * 100.0).round() as u8,
        eta_seconds: value["eta_relative"].as_f64()
            .filter(|seconds| seconds.is_finite() && *seconds >= 0.0 && *seconds < 86_400.0)
            .map(|seconds| seconds.ceil() as u64),
        preview,
        label: value["textinfo"].as_str().filter(|text| !text.is_empty())
            .unwrap_or("Генерация изображения").chars().take(120).collect(),
        ..status
    }
}

#[tauri::command]
pub(crate) async fn get_generation_progress(webui: State<'_, WebuiControl>) -> Result<GenerationProgress, String> {
    Ok(fetch_progress(&webui).await)
}

async fn fetch_progress(webui: &WebuiControl) -> GenerationProgress {
    let Some(base) = webui.ready_url() else {
        return GenerationProgress::idle(false, "Запустите WebUI для просмотра прогресса");
    };
    let Ok(client) = reqwest::Client::builder().timeout(std::time::Duration::from_secs(3)).build() else {
        return GenerationProgress::idle(false, "Прогресс WebUI недоступен");
    };
    match client.get(format!("{base}/sdapi/v1/progress"))
        .query(&[("skip_current_image", "false")]).send().await {
        Ok(response) => match response.error_for_status() {
            Ok(response) => match response.json::<Value>().await {
                Ok(value) => parse_progress(&value),
                Err(_) => GenerationProgress::idle(false, "Некорректный ответ WebUI"),
            },
            Err(_) => GenerationProgress::idle(false, "Включите --api в настройках WebUI"),
        },
        Err(_) => GenerationProgress::idle(false, "Нет связи с API WebUI"),
    }
}

#[derive(Default)]
struct CompletionTracker {
    initialized: bool,
    last_job: Option<String>,
    was_active: bool,
}

impl CompletionTracker {
    fn observe(&mut self, progress: &GenerationProgress) -> bool {
        if !progress.available { *self = Self::default(); return false; }
        let changed = self.initialized && progress.job_id.is_some() && progress.job_id != self.last_job;
        let finished = !progress.active && (self.was_active || changed)
            && progress.completed_jobs > 0 && !progress.interrupted;
        self.initialized = true;
        self.was_active = progress.active;
        self.last_job = progress.job_id.clone();
        finished
    }
}

/// Keep gallery refresh events working even when Home is not visible.
/// This monitor emits internal events only; it never displays notifications.
pub(crate) fn start_completion_monitor(app: AppHandle) {
    std::thread::spawn(move || {
        let Ok(client) = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(3)).build() else { return; };
        let mut tracker = CompletionTracker::default();
        let mut previous_url = None;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(3));
            let webui = app.state::<WebuiControl>();
            let Some(url) = webui.ready_url().filter(|_| !webui.is_stopping()) else {
                tracker = CompletionTracker::default(); previous_url = None; continue;
            };
            if previous_url.as_ref() != Some(&url) { tracker = CompletionTracker::default(); }
            previous_url = Some(url.clone());
            let progress = client.get(format!("{url}/sdapi/v1/progress"))
                .query(&[("skip_current_image", "true")]).send()
                .and_then(reqwest::blocking::Response::error_for_status)
                .and_then(|response| response.json::<Value>()).map(|value| parse_progress(&value));
            let Ok(progress) = progress else { tracker = CompletionTracker::default(); continue; };
            if webui.is_stopping() || webui.ready_url().as_ref() != Some(&url) {
                tracker = CompletionTracker::default(); continue;
            }
            if !tracker.observe(&progress) { continue; }
            let _ = app.emit("flow:generation-complete", ());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{parse_progress, CompletionTracker};
    use serde_json::json;

    fn snapshot(active: bool, id: &str, completed: u64, interrupted: bool) -> super::GenerationProgress {
        parse_progress(&json!({"state": {"job_count": if active { 1 } else { 0 },
            "job_timestamp": id, "job_no": completed, "interrupted": interrupted}}))
    }

    #[test]
    fn emits_completion_once_without_replaying_old_jobs() {
        let mut tracker = CompletionTracker::default();
        assert!(!tracker.observe(&snapshot(false, "old", 1, false)));
        assert!(!tracker.observe(&snapshot(true, "new", 0, false)));
        assert!(!tracker.observe(&snapshot(true, "new", 1, false)));
        assert!(tracker.observe(&snapshot(false, "new", 2, false)));
        assert!(!tracker.observe(&snapshot(false, "new", 2, false)));
        assert!(!tracker.observe(&snapshot(false, "new", 2, false)));
        assert!(!tracker.observe(&snapshot(true, "new", 0, false)));
        assert!(tracker.observe(&snapshot(false, "new", 1, false)));
    }

    #[test]
    fn detects_short_jobs_and_ignores_cancellation_and_connection_loss() {
        let mut tracker = CompletionTracker::default();
        assert!(!tracker.observe(&snapshot(false, "old", 1, false)));
        assert!(tracker.observe(&snapshot(false, "short", 1, false)));
        assert!(!tracker.observe(&snapshot(true, "cancelled", 0, false)));
        assert!(!tracker.observe(&snapshot(false, "cancelled", 1, true)));
        assert!(!tracker.observe(&snapshot(true, "failed", 0, false)));
        assert!(!tracker.observe(&snapshot(false, "failed", 0, false)));
        assert!(!tracker.observe(&snapshot(true, "lost", 0, false)));
        assert!(!tracker.observe(&super::GenerationProgress::idle(false, "offline")));
        assert!(!tracker.observe(&snapshot(false, "old", 1, false)));
    }

    #[test]
    fn retains_completion_and_cancellation_state_after_job_ends() {
        let done = parse_progress(&json!({"state": {"job_count": 0,
            "job_timestamp": "20261108120000", "job_no": 1}}));
        assert!(!done.active);
        assert_eq!(done.job_id.as_deref(), Some("20261108120000"));
        assert_eq!(done.completed_jobs, 1);
        assert!(!done.interrupted);
        for flag in ["interrupted", "skipped", "stopping_generation"] {
            let mut value = json!({"state": {"job_count": 0, "job_no": 1}});
            value["state"][flag] = json!(true);
            assert!(parse_progress(&value).interrupted);
        }
        let preparing = parse_progress(&json!({"state": {"job_count": -1}}));
        assert!(preparing.active);
    }

    #[test]
    fn ignores_preview_when_idle_and_clamps_progress() {
        let idle = parse_progress(&json!({"state": {"job_count": 0}, "current_image": "abc"}));
        assert!(!idle.active);
        assert!(idle.preview.is_none());
        let running = parse_progress(&json!({"state": {"job_count": 1}, "progress": 1.5,
            "eta_relative": 12.2, "current_image": "AQID"}));
        assert_eq!(running.percent, 100);
        assert_eq!(running.eta_seconds, Some(13));
        assert_eq!(running.preview.as_deref(), Some("data:image/png;base64,AQID"));
    }
}
