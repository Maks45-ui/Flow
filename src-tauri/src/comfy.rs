use std::{fs, path::{Path, PathBuf}, process::{Command, Stdio}, sync::Arc};
use tauri::{AppHandle, Manager, State};
use crate::installer::{self, InstallControl, WebuiControl};

const REPOSITORY: &str = "https://github.com/Comfy-Org/ComfyUI.git";
const EMBED_NODE: &str = "flow_embedded_ui";
const EMBED_SCRIPT: &str = include_str!("../resources/flow_comfy_embed.py");

fn frame_origin(app: &AppHandle) -> Result<String, String> {
    let url = app.get_webview_window("main").ok_or("Окно Flow недоступно.")?
        .url().map_err(|error| error.to_string())?;
    if url.scheme() != "http" || !matches!(url.host_str(), Some("tauri.localhost" | "localhost" | "127.0.0.1")) {
        return Err("Адрес окна Flow не поддерживает встроенный ComfyUI.".into());
    }
    Ok(url.origin().ascii_serialization())
}

fn allow_embed_node(arguments: &mut Vec<String>) {
    if !arguments.iter().any(|arg| arg == "--disable-all-custom-nodes") { return; }
    // Keep the user's whitelist and allow only our integration when custom nodes are disabled.
    if let Some(index) = arguments.iter().position(|arg| arg == "--whitelist-custom-nodes") {
        let listed = arguments[index + 1..].iter().take_while(|arg| !arg.starts_with("--"));
        if !listed.clone().any(|arg| arg == EMBED_NODE) { arguments.insert(index + 1, EMBED_NODE.into()); }
    } else if let Some(index) = arguments.iter().position(|arg| arg.starts_with("--whitelist-custom-nodes=")) {
        let value = arguments[index].split_once('=').map(|(_, value)| value.to_owned()).unwrap_or_default();
        arguments.splice(index..=index, ["--whitelist-custom-nodes".into(), EMBED_NODE.into(), value]);
    } else {
        arguments.extend(["--whitelist-custom-nodes".into(), EMBED_NODE.into()]);
    }
}

/// Probe exactly the navigation the iframe will make, not just a bare HTTP GET.
#[tauri::command]
pub(crate) async fn check_comfy_frame(app: AppHandle, webui: State<'_, WebuiControl>) -> Result<u16, String> {
    if webui.package_id().as_deref() != Some("comfyui") { return Err("ComfyUI не запущен.".into()); }
    let raw = webui.ready_url().ok_or("ComfyUI ещё не готов.")?;
    let url = reqwest::Url::parse(&raw).map_err(|error| error.to_string())?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || url.port().is_none()
        || !url.username().is_empty() || url.password().is_some() || url.path() != "/"
        || url.query().is_some() || url.fragment().is_some() {
        return Err("Недопустимый локальный адрес ComfyUI.".into());
    }
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none()).build().map_err(|error| error.to_string())?;
    client.get(url).header("Sec-Fetch-Site", "cross-site").header("Sec-Fetch-Dest", "iframe")
        .header("Sec-Fetch-Mode", "navigate").header("Referer", format!("{}/", frame_origin(&app)?))
        .send().await.map(|response| response.status().as_u16()).map_err(|error| error.to_string())
}

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
    let mut arguments = installer::parse_webui_arguments(&crate::webui_arguments(&app)?)?;
    // These launch options are owned by Flow so the iframe always talks to a local server.
    for arg in &arguments {
        let flag = arg.split('=').next().unwrap_or(arg);
        if matches!(flag, "--listen" | "--port" | "--auto-launch" | "--disable-auto-launch" | "--extra-model-paths-config" | "--tls-keyfile" | "--tls-certfile" | "--base-directory" | "--output-directory") {
            return Err(format!("Параметр {flag} управляется Flow для ComfyUI."));
        }
    }
    let embed = directory.join("custom_nodes").join(EMBED_NODE);
    fs::create_dir_all(&embed).map_err(|error| error.to_string())?;
    fs::write(embed.join("__init__.py"), EMBED_SCRIPT).map_err(|error| error.to_string())?;
    allow_embed_node(&mut arguments);
    let port = (8188..8288).find(|port| std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, *port)).is_ok())
        .ok_or("Нет свободного порта для ComfyUI.")?;
    let mut command = Command::new(installer::venv_python(&directory));
    command.args(["-u", "main.py", "--listen", "127.0.0.1", "--port", &port.to_string(),
        "--disable-auto-launch", "--extra-model-paths-config"]).arg(&config).args(&arguments)
        .current_dir(&directory).env("PYTHONUNBUFFERED", "1").env("PYTHONIOENCODING", "utf-8:backslashreplace")
        .env("PYTHONFAULTHANDLER", "1").env_remove("COMMANDLINE_ARGS").stdin(Stdio::null());
    command.env("FLOW_COMFY_EMBED_ORIGIN", frame_origin(&app)?);
    installer::start_process(app, webui, "comfyui".into(), command, None, false, arguments)
}

#[cfg(test)]
mod tests {
    #[test]
    fn retains_custom_node_restrictions_and_existing_whitelist() {
        let mut args = vec!["--disable-all-custom-nodes".into(), "--whitelist-custom-nodes".into(), "user_node".into(), "--lowvram".into()];
        super::allow_embed_node(&mut args);
        super::allow_embed_node(&mut args);
        assert_eq!(args, ["--disable-all-custom-nodes", "--whitelist-custom-nodes", "flow_embedded_ui", "user_node", "--lowvram"]);
        let mut disabled = vec!["--disable-all-custom-nodes".into()];
        super::allow_embed_node(&mut disabled);
        assert_eq!(disabled, ["--disable-all-custom-nodes", "--whitelist-custom-nodes", "flow_embedded_ui"]);
        let mut equals = vec!["--disable-all-custom-nodes".into(), "--whitelist-custom-nodes=user_node".into()];
        super::allow_embed_node(&mut equals);
        assert_eq!(equals, ["--disable-all-custom-nodes", "--whitelist-custom-nodes", "flow_embedded_ui", "user_node"]);
    }
    #[test]
    fn shares_model_paths_without_copying_or_yaml_injection() {
        let text = super::model_paths(std::path::Path::new("D:/Модели/# shared"));
        let config: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(config["flow"]["base_path"], "D:/Модели/# shared");
        assert_eq!(config["flow"]["checkpoints"], "Stable-diffusion");
        assert_eq!(config["flow"]["loras"], "Lora");
    }
}
