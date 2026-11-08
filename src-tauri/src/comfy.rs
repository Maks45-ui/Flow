use std::{fs, path::{Path, PathBuf}, process::{Command, Stdio}, sync::Arc};
use tauri::{AppHandle, State};
use crate::installer::{self, InstallControl, WebuiControl};

const REPOSITORY: &str = "https://github.com/Comfy-Org/ComfyUI.git";

pub(crate) fn ready(directory: &Path) -> bool {
    directory.join("main.py").is_file() && directory.join("comfy").is_dir()
        && installer::venv_python(directory).is_file() && directory.join(".flow-installed.json").is_file()
}

fn install(app: &AppHandle, control: &InstallControl, parent: &Path) -> Result<(), String> {
    installer::notify(app, "checking", "Подготовка отдельного пакета ComfyUI…");
    crate::managed_tools::ensure_git(app, control, parent)?;
    let directory = parent.join("ComfyUI");
    if !directory.join(".git").is_dir() {
        installer::notify(app, "cloning", "Скачивание официального ComfyUI…");
        installer::run_logged(app, control, "git", &["clone".into(), "--depth".into(), "1".into(), "--progress".into(),
            REPOSITORY.into(), directory.to_string_lossy().into_owned()], parent, None)?;
    } else {
        let origin = installer::command_output(app, "git", &["-C".into(), directory.to_string_lossy().into_owned(),
            "remote".into(), "get-url".into(), "origin".into()])?;
        if origin.trim_end_matches('/').trim_end_matches(".git").to_lowercase()
            != REPOSITORY.trim_end_matches(".git").to_lowercase() {
            return Err("Папка ComfyUI занята другим репозиторием.".into());
        }
    }
    if !directory.join("main.py").is_file() || !directory.join("comfy").is_dir() {
        return Err("Скачивание ComfyUI не завершено. Проверьте папку пакета перед повторной установкой.".into());
    }
    let uv = crate::managed_tools::ensure_uv(control, parent)?;
    let tools = parent.join(".flow-tools");
    let python_store = tools.join("python");
    let cache = tools.join("uv-cache");
    let pip_cache = tools.join("pip-cache");
    let python = installer::venv_python(&directory);
    if !python.is_file() {
        installer::notify(app, "venv", "Создание окружения Python 3.13 для ComfyUI…");
        installer::run_logged_with_env(app, control, &uv.to_string_lossy(), &["venv".into(), "venv".into(),
            "--python".into(), "3.13".into(), "--seed".into()], &directory,
            &[("UV_PYTHON_INSTALL_DIR", &python_store), ("UV_CACHE_DIR", &cache)])?;
    }
    let pip_env = [("PIP_CACHE_DIR", pip_cache.as_path())];
    for args in [
        vec!["-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"],
        vec!["-m", "pip", "install", "torch", "torchvision", "torchaudio", "--index-url", "https://download.pytorch.org/whl/cu130"],
        vec!["-m", "pip", "install", "-r", "requirements.txt"],
    ] {
        installer::notify(app, "dependencies", format!("ComfyUI: {}", args.join(" ")));
        installer::run_logged_retry_locked_env(app, control, &python.to_string_lossy(),
            &args.into_iter().map(str::to_owned).collect::<Vec<_>>(), &directory, &pip_env)?;
    }
    installer::run_logged(app, control, &python.to_string_lossy(), &["-c".into(),
        "import torch, aiohttp, yaml; assert torch.cuda.is_available(), 'ComfyUI requires a working NVIDIA CUDA driver'".into()], &directory, None)?;
    if control.is_cancelled() { return Err("Установка отменена.".into()); }
    let revision = installer::command_output(app, "git", &["-C".into(), directory.to_string_lossy().into_owned(),
        "rev-parse".into(), "--short".into(), "HEAD".into()])?;
    fs::write(directory.join(".flow-installed.json"), serde_json::json!({"name":"ComfyUI","version":revision}).to_string())
        .map_err(|error| error.to_string())?;
    crate::activate_comfyui(app, &directory)?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn install_comfyui(app: AppHandle, state: State<'_, Arc<InstallControl>>,
    webui: State<'_, WebuiControl>, downloads: State<'_, Arc<crate::civitai::DownloadControl>>,
    installation_dir: String) -> Result<(), String> {
    if webui.is_running() || downloads.is_running() { return Err("Остановите WebUI и загрузки перед установкой ComfyUI.".into()); }
    let selected = crate::paths::subprocess_path(&PathBuf::from(installation_dir));
    if !selected.is_absolute() || !selected.is_dir() { return Err("Выберите существующую папку установки.".into()); }
    if selected.canonicalize().map_err(|error| error.to_string())?
        != crate::installation_dir(&app)?.canonicalize().map_err(|error| error.to_string())? {
        return Err("Папка установки изменилась. Повторите выбор.".into());
    }
    state.try_start()?;
    let control = Arc::clone(&*state);
    tauri::async_runtime::spawn_blocking(move || {
        let result = install(&app, &control, &selected);
        control.finish();
        match result {
            Ok(()) => installer::notify(&app, "done", "ComfyUI установлен и готов к запуску."),
            Err(error) => installer::notify(&app, if control.was_cancelled() { "cancelled" } else { "error" }, error),
        }
    });
    Ok(())
}

pub(crate) fn model_paths(library: &Path) -> String {
    // JSON is valid YAML and safely quotes Windows paths, including non-ASCII names.
    serde_json::json!({"flow": {"base_path": library.to_string_lossy(),
        "checkpoints":"Stable-diffusion", "loras":"Lora", "vae":"VAE",
        "embeddings":"embeddings", "controlnet":"ControlNet", "upscale_models":"ESRGAN"}}).to_string()
}

pub(crate) fn launch(app: AppHandle, webui: &WebuiControl) -> Result<(), String> {
    let directory = crate::package_dir(&app)?;
    if !ready(&directory) { return Err("Сначала установите ComfyUI.".into()); }
    let library = crate::models_library_dir(&app)?;
    fs::create_dir_all(library.join("Stable-diffusion")).map_err(|error| error.to_string())?;
    let config = directory.join(".flow-model-paths.yaml");
    fs::write(&config, model_paths(&library)).map_err(|error| error.to_string())?;
    let arguments = installer::parse_webui_arguments(&crate::webui_arguments(&app)?)?;
    // Flow owns the local address and opens it once after the server reports readiness.
    for arg in &arguments {
        let flag = arg.split('=').next().unwrap_or(arg);
        if matches!(flag, "--listen" | "--port" | "--auto-launch" | "--disable-auto-launch" | "--extra-model-paths-config" | "--tls-keyfile" | "--tls-certfile" | "--base-directory" | "--output-directory") {
            return Err(format!("Параметр {flag} управляется Flow для ComfyUI."));
        }
    }
    let port = (8188..8288).find(|port| std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, *port)).is_ok())
        .ok_or("Нет свободного порта для ComfyUI.")?;
    let mut command = Command::new(installer::venv_python(&directory));
    command.args(["-u", "main.py", "--listen", "127.0.0.1", "--port", &port.to_string(),
        "--disable-auto-launch", "--extra-model-paths-config"]).arg(&config).args(&arguments)
        .current_dir(&directory).env("PYTHONUNBUFFERED", "1").env("PYTHONIOENCODING", "utf-8:backslashreplace")
        .env("PYTHONFAULTHANDLER", "1").env_remove("COMMANDLINE_ARGS").stdin(Stdio::null());
    // Older installations may retain the inactive Flow embed node. Never enable its iframe exception.
    command.env_remove("FLOW_COMFY_EMBED_ORIGIN");
    installer::start_process(app, webui, "comfyui".into(), command, None, false, arguments)
}

#[cfg(test)]
mod tests {
    #[test]
    fn shares_model_paths_without_copying_or_yaml_injection() {
        let text = super::model_paths(std::path::Path::new("D:/Модели/# shared"));
        let config: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(config["flow"]["base_path"], "D:/Модели/# shared");
        assert_eq!(config["flow"]["checkpoints"], "Stable-diffusion");
        assert_eq!(config["flow"]["loras"], "Lora");
    }
}
