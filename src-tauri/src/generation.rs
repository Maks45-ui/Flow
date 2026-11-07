use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::installer::WebuiControl;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GenerationProgress {
    available: bool,
    active: bool,
    percent: u8,
    eta_seconds: Option<u64>,
    preview: Option<String>,
    label: String,
}

impl GenerationProgress {
    fn idle(available: bool, label: &str) -> Self {
        Self { available, active: false, percent: 0, eta_seconds: None,
            preview: None, label: label.to_owned() }
    }
}

fn parse_progress(value: &Value) -> GenerationProgress {
    let jobs = value["state"]["job_count"].as_u64().unwrap_or(0);
    if jobs == 0 { return GenerationProgress::idle(true, "Генерация не выполняется"); }
    let fraction = value["progress"].as_f64().unwrap_or(0.0).clamp(0.0, 1.0);
    let preview = value["current_image"].as_str().and_then(|image| {
        let raw = image.strip_prefix("data:image/png;base64,").unwrap_or(image);
        (raw.len() <= 2_000_000 && !raw.is_empty()
            && raw.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=')))
            .then(|| format!("data:image/png;base64,{raw}"))
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
    }
}

#[tauri::command]
pub(crate) async fn get_generation_progress(webui: State<'_, WebuiControl>) -> GenerationProgress {
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

#[cfg(test)]
mod tests {
    use super::parse_progress;
    use serde_json::json;

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
