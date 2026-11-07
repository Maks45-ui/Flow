use serde::{Deserialize, Serialize};
use std::{collections::HashSet, fs, path::{Path, PathBuf}};
use tauri::{AppHandle, State};
use crate::installer::WebuiControl;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelProfile {
    pub model: String,
    pub family: String,
    pub width: u32,
    pub height: u32,
    pub sampler: String,
    pub vae: String,
    pub memory: String,
}

fn profiles(app: &AppHandle) -> Result<Vec<ModelProfile>, String> {
    let path = crate::data_dir(app)?.join("model-profiles.json");
    if !path.exists() { return Ok(Vec::new()); }
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

pub(crate) fn apply_profile_memory(app: &AppHandle, directory: &Path, arguments: &mut Vec<String>) -> Result<(), String> {
    let config = fs::read(directory.join("config.json")).ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
    let model = config.as_ref().and_then(|value| value["sd_model_checkpoint"].as_str()).unwrap_or("");
    if let Some(profile) = profiles(app)?.into_iter().find(|profile| model == profile.model || model.starts_with(&format!("{} [", profile.model))) {
        if profile.memory != "auto" {
            arguments.retain(|arg| !matches!(arg.as_str(), "--lowvram" | "--medvram" | "--medvram-sdxl"));
            arguments.push(format!("--{}", profile.memory));
        }
    }
    Ok(())
}

fn validate(profile: &ModelProfile) -> Result<(), String> {
    if profile.model.is_empty() || profile.model.len() > 512 || profile.sampler.trim().is_empty() || profile.sampler.len() > 100
        || profile.vae.len() > 512 || !matches!(profile.family.as_str(), "sd15" | "sdxl")
        || !matches!(profile.memory.as_str(), "auto" | "lowvram" | "medvram-sdxl")
        || !(256..=2048).contains(&profile.width) || !(256..=2048).contains(&profile.height)
        || profile.width % 8 != 0 || profile.height % 8 != 0 {
        return Err("Проверьте профиль: размеры 256–2048 с шагом 8 и корректный режим памяти.".to_owned());
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn get_model_profiles(app: AppHandle) -> Result<Vec<ModelProfile>, String> { profiles(&app) }

#[tauri::command]
pub(crate) fn save_model_profile(app: AppHandle, profile: ModelProfile) -> Result<(), String> {
    validate(&profile)?;
    let mut list = profiles(&app)?;
    list.retain(|item| item.model != profile.model);
    list.push(profile);
    let path = crate::data_dir(&app)?.join("model-profiles.json");
    fs::write(path, serde_json::to_vec_pretty(&list).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn generate_with_profile(app: AppHandle, webui: State<'_, WebuiControl>, model: String, prompt: String) -> Result<(), String> {
    if prompt.trim().is_empty() || prompt.len() > 10_000 { return Err("Введите промпт (до 10000 символов).".to_owned()); }
    let base = webui.ready_url().ok_or("Сначала запустите WebUI.")?;
    let profile = profiles(&app)?.into_iter().find(|item| item.model == model).ok_or("Сначала сохраните профиль модели.")?;
    validate(&profile)?;
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(1800)).build().map_err(|e| e.to_string())?;
    let response = client.post(format!("{base}/sdapi/v1/txt2img")).json(&serde_json::json!({
        "prompt": prompt, "width": profile.width, "height": profile.height,
        "sampler_name": profile.sampler, "steps": 24, "batch_size": 1,
        "save_images": true, "send_images": false,
        "override_settings": {"sd_model_checkpoint": profile.model, "sd_vae": profile.vae},
        "override_settings_restore_afterwards": false
    })).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("WebUI: {}. Проверьте имя sampler/VAE и доступность --api.", response.status()));
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StorageFile { path: String, name: String, size_bytes: u64, category: &'static str }
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StorageReport { models_bytes: u64, outputs_bytes: u64, packages_bytes: u64, files: Vec<StorageFile>, skipped: u64 }

fn scan(root: &Path, category: &'static str, report: &mut StorageReport, seen: &mut HashSet<PathBuf>) {
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = fs::read_dir(dir) else { report.skipped += 1; continue; };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else { continue; };
            if kind.is_symlink() { continue; }
            let path = entry.path();
            if kind.is_dir() { pending.push(path); continue; }
            if !kind.is_file() { continue; }
            let Ok(canonical) = path.canonicalize() else { continue; };
            if !seen.insert(canonical) { continue; }
            let Ok(meta) = entry.metadata() else { continue; };
            let bytes = meta.len();
            match category { "models" => report.models_bytes += bytes, "outputs" => report.outputs_bytes += bytes, _ => report.packages_bytes += bytes }
            report.files.push(StorageFile { path: crate::paths::subprocess_path(&path).to_string_lossy().into_owned(),
                name: entry.file_name().to_string_lossy().into_owned(), size_bytes: bytes, category });
        }
    }
}

#[tauri::command]
pub(crate) async fn get_storage_report(app: AppHandle) -> Result<StorageReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut report = StorageReport::default();
        let mut seen = HashSet::new();
        let library = crate::models_library_dir(&app)?;
        if library.is_dir() { scan(&library, "models", &mut report, &mut seen); }
        let mut packages = vec![crate::installation_dir(&app)?.join("sd-webui")];
        if let Some(forge) = crate::read_settings(&app)?.forge_neo_dir { packages.push(PathBuf::from(forge)); }
        for package in &packages {
            for outputs in ["outputs", "output"] { let root = package.join(outputs); if root.is_dir() { scan(&root, "outputs", &mut report, &mut seen); } }
            let models = package.join("models"); if models.is_dir() { scan(&models, "models", &mut report, &mut seen); }
        }
        for package in packages { if package.is_dir() { scan(&package, "packages", &mut report, &mut seen); } }
        report.files.sort_unstable_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
        report.files.truncate(15);
        Ok(report)
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn profile_dimensions_are_bounded() {
        let mut p = ModelProfile { model: "test".into(), family: "sdxl".into(), width: 1024, height: 1024,
            sampler: "Euler".into(), vae: "Automatic".into(), memory: "auto".into() };
        assert!(validate(&p).is_ok()); p.width = 1025; assert!(validate(&p).is_err());
    }
    #[test]
    fn storage_counts_shared_paths_once() {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("flow-storage-{stamp}"));
        fs::create_dir_all(root.join("models")).unwrap();
        fs::write(root.join("models/example.safetensors"), b"model").unwrap();
        fs::write(root.join("launch.py"), b"app").unwrap();
        let mut report = StorageReport::default(); let mut seen = HashSet::new();
        scan(&root.join("models"), "models", &mut report, &mut seen);
        scan(&root, "packages", &mut report, &mut seen);
        assert_eq!(report.models_bytes, 5); assert_eq!(report.packages_bytes, 3);
        assert_eq!(report.files.len(), 2);
        fs::remove_dir_all(root).unwrap();
    }
}
