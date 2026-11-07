use serde::Serialize;
use std::{collections::HashSet, fs, io::Read, path::{Path, PathBuf}, sync::Arc, time::{SystemTime, UNIX_EPOCH}};
use tauri::{AppHandle, State};

use crate::{installer::InstallControl, paths};

const MODEL_FOLDERS: [(&str, &str); 3] = [
    ("Stable-diffusion", "Checkpoint"),
    ("Lora", "LoRA"),
    ("VAE", "VAE"),
];

struct ModelRoot {
    path: PathBuf,
    model_type: &'static str,
    source: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstalledModel {
    path: String,
    name: String,
    model_type: &'static str,
    source: &'static str,
    size_bytes: u64,
}

fn supported_model(path: &Path) -> bool {
    path.extension().and_then(|value| value.to_str())
        .is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(),
            "safetensors" | "ckpt" | "pt" | "pth" | "bin"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportDestination {
    model_type: &'static str,
    path: String,
    duplicate: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelImportPreview {
    name: String,
    size_bytes: u64,
    suggested_type: &'static str,
    destinations: Vec<ImportDestination>,
}

fn import_source(path: &str) -> Result<PathBuf, String> {
    let source = Path::new(path);
    if !source.is_absolute() || !supported_model(source) {
        return Err("Выберите файл модели .safetensors, .ckpt, .pt, .pth или .bin.".to_owned());
    }
    let metadata = fs::symlink_metadata(source).map_err(|error| format!("Не удалось открыть модель: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Импортировать можно только обычный файл модели.".to_owned());
    }
    source.canonicalize().map_err(|error| error.to_string())
}

fn guessed_type(source: &Path) -> &'static str {
    if !source.extension().and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("safetensors")) {
        return "Checkpoint";
    }
    let Ok(mut file) = fs::File::open(source) else { return "Checkpoint"; };
    let mut length = [0u8; 8];
    if file.read_exact(&mut length).is_err() { return "Checkpoint"; }
    let bytes = u64::from_le_bytes(length);
    if bytes > 2_000_000 { return "Checkpoint"; }
    let Ok(mut header) = usize::try_from(bytes).map(|size| vec![0; size]) else { return "Checkpoint"; };
    if file.read_exact(&mut header).is_err() { return "Checkpoint"; }
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&header) else { return "Checkpoint"; };
    let Some(keys) = value.as_object() else { return "Checkpoint"; };
    if keys.get("__metadata__").and_then(|value| value.get("ss_network_module")).is_some()
        || keys.keys().any(|key| key.starts_with("lora_") || key.contains(".lora_down.")) {
        return "LoRA";
    }
    if keys.keys().any(|key| key.starts_with("encoder."))
        && keys.keys().any(|key| key.starts_with("decoder.")) { return "VAE"; }
    "Checkpoint"
}

fn import_preview(source: &Path, library: &Path) -> Result<ModelImportPreview, String> {
    let name = source.file_name().and_then(|value| value.to_str())
        .ok_or("Имя файла модели не поддерживается.")?.to_owned();
    let size_bytes = fs::metadata(source).map_err(|error| error.to_string())?.len();
    let destinations = MODEL_FOLDERS.iter().map(|(folder, model_type)| {
        let path = library.join(folder).join(&name);
        ImportDestination { model_type, path: paths::subprocess_path(&path).to_string_lossy().into_owned(),
            duplicate: path.exists() }
    }).collect();
    Ok(ModelImportPreview { name, size_bytes, suggested_type: guessed_type(source), destinations })
}

fn copy_model(source: &Path, destination: &Path) -> Result<(), String> {
    if destination.exists() { return Err("Модель с таким именем уже есть в выбранной папке.".to_owned()); }
    let parent = destination.parent().ok_or("Некорректная папка модели.")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let temporary = parent.join(format!(".flow-import-{}-{stamp}.part", std::process::id()));
    let copied = (|| {
        let bytes = fs::copy(source, &temporary).map_err(|error| error.to_string())?;
        if bytes != fs::metadata(source).map_err(|error| error.to_string())?.len() {
            return Err("Размер скопированной модели не совпадает с исходным.".to_owned());
        }
        if destination.exists() { return Err("Модель с таким именем уже появилась в папке.".to_owned()); }
        fs::rename(&temporary, destination).map_err(|error| error.to_string())
    })();
    if copied.is_err() { let _ = fs::remove_file(&temporary); }
    copied
}

#[tauri::command]
pub(crate) async fn inspect_model_import(app: AppHandle, path: String) -> Result<ModelImportPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        import_preview(&import_source(&path)?, &crate::models_library_dir(&app)?)
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn import_model_file(app: AppHandle, path: String, model_type: String,
    installs: State<'_, Arc<InstallControl>>) -> Result<String, String> {
    if installs.is_running() { return Err("Дождитесь окончания установки пакета.".to_owned()); }
    tauri::async_runtime::spawn_blocking(move || {
        let source = import_source(&path)?;
        let folder = MODEL_FOLDERS.iter().find(|(_, kind)| *kind == model_type)
            .map(|(folder, _)| *folder).ok_or("Выберите тип модели.")?;
        let target = crate::models_library_dir(&app)?.join(folder).join(source.file_name().ok_or("Некорректное имя файла.")?);
        if target.exists() && target.canonicalize().ok().as_deref() == Some(source.as_path()) {
            return Err("Эта модель уже находится в общей библиотеке.".to_owned());
        }
        copy_model(&source, &target)?;
        Ok(paths::subprocess_path(&target).to_string_lossy().into_owned())
    }).await.map_err(|error| error.to_string())?
}

fn model_roots(app: &AppHandle) -> Result<Vec<ModelRoot>, String> {
    let mut bases = vec![(crate::models_library_dir(app)?, "Общая библиотека")];
    if let Ok(package) = crate::package_dir(app) {
        bases.push((package.join("models"), "Активный пакет"));
    }
    let mut roots = Vec::new();
    let mut seen = HashSet::new();
    for (base, source) in bases {
        for (folder, model_type) in MODEL_FOLDERS {
            let path = base.join(folder);
            if !path.is_dir() { continue; }
            let canonical = path.canonicalize().map_err(|error| error.to_string())?;
            if seen.insert(canonical.clone()) {
                roots.push(ModelRoot { path: canonical, model_type, source });
            }
        }
    }
    Ok(roots)
}

fn collect_models(roots: &[ModelRoot]) -> Result<Vec<InstalledModel>, String> {
    let mut result = Vec::new();
    let mut seen_files = HashSet::new();
    for root in roots {
        let mut pending = vec![root.path.clone()];
        let mut seen_dirs = HashSet::new();
        while let Some(directory) = pending.pop() {
            if !seen_dirs.insert(directory.clone()) { continue; }
            for entry in fs::read_dir(&directory).map_err(|error| format!("{}: {error}", directory.display()))? {
                let entry = entry.map_err(|error| error.to_string())?;
                let kind = entry.file_type().map_err(|error| error.to_string())?;
                if kind.is_symlink() { continue; }
                let path = entry.path();
                if kind.is_dir() {
                    let canonical = path.canonicalize().map_err(|error| error.to_string())?;
                    if canonical.starts_with(&root.path) { pending.push(canonical); }
                } else if kind.is_file() && supported_model(&path) {
                    let canonical = path.canonicalize().map_err(|error| error.to_string())?;
                    if !canonical.starts_with(&root.path) || !seen_files.insert(canonical.clone()) { continue; }
                    let size_bytes = entry.metadata().map_err(|error| error.to_string())?.len();
                    result.push(InstalledModel {
                        path: paths::subprocess_path(&canonical).to_string_lossy().into_owned(),
                        name: entry.file_name().to_string_lossy().into_owned(),
                        model_type: root.model_type,
                        source: root.source,
                        size_bytes,
                    });
                }
            }
        }
    }
    result.sort_unstable_by(|left, right| left.model_type.cmp(right.model_type)
        .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase())));
    Ok(result)
}

fn checked_model(path: &str, roots: &[ModelRoot]) -> Result<PathBuf, String> {
    let candidate = Path::new(path);
    if !candidate.is_absolute() || !supported_model(candidate) {
        return Err("Выберите файл модели из библиотеки Flow.".to_owned());
    }
    let metadata = fs::symlink_metadata(candidate).map_err(|error| format!("Модель не найдена: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Можно удалить только обычный файл модели.".to_owned());
    }
    let canonical = candidate.canonicalize().map_err(|error| error.to_string())?;
    if !roots.iter().any(|root| canonical.starts_with(&root.path)) {
        return Err("Файл находится вне папок моделей Flow.".to_owned());
    }
    Ok(canonical)
}

fn remove_model(path: &str, roots: &[ModelRoot]) -> Result<(), String> {
    let model = checked_model(path, roots)?;
    fs::remove_file(&model).map_err(|error| format!("Не удалось удалить {}: {error}", model.display()))
}

#[tauri::command]
pub(crate) async fn list_installed_models(app: AppHandle) -> Result<Vec<InstalledModel>, String> {
    tauri::async_runtime::spawn_blocking(move || collect_models(&model_roots(&app)?))
        .await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) fn delete_installed_model(
    app: AppHandle,
    path: String,
    installs: State<'_, Arc<InstallControl>>,
) -> Result<(), String> {
    if installs.is_running() {
        return Err("Дождитесь завершения установки пакета перед удалением модели.".to_owned());
    }
    remove_model(&path, &model_roots(&app)?)
}

#[cfg(test)]
mod tests {
    use super::{checked_model, collect_models, copy_model, guessed_type, remove_model, supported_model, ModelRoot};
    use std::{fs, time::{SystemTime, UNIX_EPOCH}};

    #[test]
    fn imports_without_overwriting_and_recognizes_lora_header() {
        let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let base = std::env::temp_dir().join(format!("flow-import-test-{suffix}"));
        fs::create_dir_all(&base).unwrap();
        let source = base.join("test.safetensors");
        let header = br#"{"lora_unet_test": {}}"#;
        let mut bytes = (header.len() as u64).to_le_bytes().to_vec();
        bytes.extend_from_slice(header);
        fs::write(&source, &bytes).unwrap();
        assert_eq!(guessed_type(&source), "LoRA");
        let target = base.join("library/Lora/test.safetensors");
        copy_model(&source, &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), bytes);
        assert!(copy_model(&source, &target).is_err());
        assert!(source.exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn scans_nested_models_and_rejects_files_outside_library() {
        let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let base = std::env::temp_dir().join(format!("flow-model-manager-{suffix}"));
        let root = base.join("Stable-diffusion");
        let nested = root.join("SDXL");
        fs::create_dir_all(&nested).unwrap();
        let model = nested.join("example.safetensors");
        let outside = base.join("outside.safetensors");
        fs::write(&model, b"model").unwrap();
        fs::write(&outside, b"other").unwrap();
        let roots = [ModelRoot { path: root.canonicalize().unwrap(), model_type: "Checkpoint", source: "test" }];
        let found = collect_models(&roots).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "example.safetensors");
        assert!(checked_model(model.to_str().unwrap(), &roots).is_ok());
        assert!(checked_model(outside.to_str().unwrap(), &roots).is_err());
        assert!(remove_model(outside.to_str().unwrap(), &roots).is_err());
        assert!(outside.exists());
        remove_model(model.to_str().unwrap(), &roots).unwrap();
        assert!(!model.exists());
        assert!(!supported_model(&nested.join("notes.txt")));
        fs::remove_dir_all(base).unwrap();
    }
}

