use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

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
    if webui.package_id().as_deref() == Some("comfyui") {
        let queue = match client.get(format!("{base}/queue")).send().await {
            Ok(response) => match response.error_for_status() {
                Ok(response) => response.json::<Value>().await.ok(), Err(_) => None,
            }, Err(_) => None,
        };
        let Some(queue) = queue else { return GenerationProgress::idle(false, "Нет связи с API ComfyUI"); };
        return parse_comfy_progress(&queue, None);
    }
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

fn parse_comfy_progress(queue: &Value, history: Option<&Value>) -> GenerationProgress {
    let mut result = GenerationProgress::idle(true, "Генерация не выполняется");
    if let Some(job) = queue["queue_running"].as_array().and_then(|jobs| jobs.first()) {
        result.active = true;
        result.indeterminate = true;
        result.job_id = job[1].as_str().map(str::to_owned);
        result.label = "Выполняется workflow ComfyUI".into();
    } else if let Some((id, job)) = history.and_then(Value::as_object).and_then(|items| items.iter().next()) {
        result.job_id = Some(id.clone());
        let successful = job["status"]["completed"].as_bool() == Some(true)
            && job["status"]["status_str"].as_str() == Some("success");
        let has_images = job["outputs"].as_object().is_some_and(|outputs| outputs.values()
            .any(|node| node["images"].as_array().is_some_and(|images| !images.is_empty())));
        result.completed_jobs = u64::from(successful && has_images);
        result.interrupted = !successful;
    }
    result
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

/// Native worker: completion notifications do not depend on WebView timers or a
/// visible Home page. It requests state only, never preview images.
pub(crate) fn start_notification_monitor(app: AppHandle) {
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
            let progress = if webui.package_id().as_deref() == Some("comfyui") {
                client.get(format!("{url}/queue")).send()
                    .and_then(reqwest::blocking::Response::error_for_status)
                    .and_then(|response| response.json::<Value>()).and_then(|queue| {
                        if queue["queue_running"].as_array().is_some_and(|jobs| !jobs.is_empty()) {
                            return Ok(parse_comfy_progress(&queue, None));
                        }
                        client.get(format!("{url}/history")).query(&[("max_items", "1")]).send()
                            .and_then(reqwest::blocking::Response::error_for_status)
                            .and_then(|response| response.json::<Value>())
                            .map(|history| parse_comfy_progress(&queue, Some(&history)))
                    })
            } else {
                client.get(format!("{url}/sdapi/v1/progress"))
                    .query(&[("skip_current_image", "true")]).send()
                    .and_then(reqwest::blocking::Response::error_for_status)
                    .and_then(|response| response.json::<Value>()).map(|value| parse_progress(&value))
            };
            let Ok(progress) = progress else { tracker = CompletionTracker::default(); continue; };
            if webui.is_stopping() || webui.ready_url().as_ref() != Some(&url) {
                tracker = CompletionTracker::default(); continue;
            }
            if !tracker.observe(&progress) { continue; }
            let _ = app.emit("flow:generation-complete", ());
            let Ok(settings) = crate::read_settings(&app) else { continue; };
            if settings.generation_notifications_disabled { continue; }
            let body = if settings.notification_language == "en" {
                "Generation complete. Your image is ready!"
            } else { "Генерация завершена. Изображение готово!" };
            if let Err(error) = app.notification().builder().title("Flow").body(body).show() {
                eprintln!("Flow generation notification: {error}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{parse_progress, CompletionTracker};
    use serde_json::json;

    #[test]
    fn comfy_completion_requires_successful_image_output_and_deduplicates() {
        let active = super::parse_comfy_progress(&json!({"queue_running": [[1, "job-1"]]}), None);
        assert!(active.active);
        assert!(active.indeterminate);
        let history = json!({"job-1": {"status": {"completed": true, "status_str": "success"},
            "outputs": {"9": {"images": [{"filename":"test.png"}]}}}});
        let finished = super::parse_comfy_progress(&json!({"queue_running": []}), Some(&history));
        let mut tracker = CompletionTracker::default();
        assert!(!tracker.observe(&active));
        assert!(tracker.observe(&finished));
        assert!(!tracker.observe(&finished));
        let error = json!({"job-2": {"status": {"completed": false, "status_str": "error"}, "outputs": {}}});
        assert_eq!(super::parse_comfy_progress(&json!({"queue_running": []}), Some(&error)).completed_jobs, 0);
    }

    fn snapshot(active: bool, id: &str, completed: u64, interrupted: bool) -> super::GenerationProgress {
        parse_progress(&json!({"state": {"job_count": if active { 1 } else { 0 },
            "job_timestamp": id, "job_no": completed, "interrupted": interrupted}}))
    }

    #[test]
    fn notifies_once_and_does_not_replay_old_or_muted_jobs() {
        let mut tracker = CompletionTracker::default();
        assert!(!tracker.observe(&snapshot(false, "old", 1, false)));
        assert!(!tracker.observe(&snapshot(true, "new", 0, false)));
        assert!(!tracker.observe(&snapshot(true, "new", 1, false)));
        assert!(tracker.observe(&snapshot(false, "new", 2, false)));
        assert!(!tracker.observe(&snapshot(false, "new", 2, false)));
        // The state is consumed before checking preferences, so enabling later
        // cannot replay a completion that occurred while notifications were off.
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
    fn notification_preference_defaults_on_and_round_trips() {
        let mut settings: crate::Settings = serde_json::from_value(json!({})).unwrap();
        assert!(!settings.generation_notifications_disabled);
        settings.generation_notifications_disabled = true;
        settings.notification_language = "en".to_owned();
        let restored: crate::Settings = serde_json::from_value(serde_json::to_value(settings).unwrap()).unwrap();
        assert!(restored.generation_notifications_disabled);
        assert_eq!(restored.notification_language, "en");
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
