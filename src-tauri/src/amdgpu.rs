use std::{fs, path::{Path, PathBuf}, process::{Command, Stdio}, sync::Arc};
use tauri::{AppHandle, State};
use crate::installer::{self, InstallControl, WebuiControl};

pub(crate) const REPOSITORY: &str = "https://github.com/lshqqytiger/stable-diffusion-webui-amdgpu-forge.git";
pub(crate) const FOLDER: &str = "sd-webui-amdgpu-forge";

pub(crate) fn ready(directory: &Path) -> bool {
    directory.join("launch.py").is_file() && directory.join("modules_forge").is_dir()
        && installer::venv_python(directory).is_file() && directory.join(".flow-installed.json").is_file()
}

// DirectML currently pins torch 2.4.1. Keep its NumPy 1.x ABI and a compatible blendmodes release.
fn requirements(source: &str) -> String {
    let mut lines: Vec<String> = source.lines().filter(|line| {
        !["numpy", "blendmodes", "torch", "torchvision", "torch-directml"].iter()
            .any(|name| line.split(['=', '<', '>', '[', ' ', ';']).next() == Some(*name))
    }).map(str::to_owned).collect();
    lines.extend(["numpy==1.26.4", "blendmodes==2024.1.1", "torch==2.4.1", "torchvision==0.19.1", "torch-directml==0.2.5.dev240914"].map(str::to_owned));
    format!("{}\n", lines.join("\n"))
}

pub(crate) fn arguments(mut args: Vec<String>) -> Result<Vec<String>, String> {
    for arg in &args {
        let flag = arg.split('=').next().unwrap_or(arg);
        if matches!(flag, "--xformers" | "--reinstall-xformers" | "--use-zluda" | "--zluda" | "--use-ipex" | "--use-directml" | "--use-cpu-torch") {
            return Err(format!("AMDGPU Forge использует DirectML. Уберите несовместимый параметр {flag}."));
        }
    }
    if let Some(index) = args.iter().position(|arg| arg == "--directml") {
        // Upstream prepare_environment tests truthiness: index 0 incorrectly selects the CUDA path.
        if args.get(index + 1).is_some_and(|value| value == "0") { args[index + 1] = "-1".into(); }
    } else { args.push("--directml".into()); }
    if !args.iter().any(|arg| arg == "--disable-xformers") { args.push("--disable-xformers".into()); }
    Ok(args)
}

pub(crate) fn install(app: &AppHandle, control: &InstallControl, parent: &Path) -> Result<(), String> {
    if !cfg!(windows) { return Err("Установка AMDGPU Forge DirectML поддерживается в Windows.".into()); }
    installer::notify(app, "checking", "Подготовка WebUI AMDGPU Forge · DirectML…");
    crate::managed_tools::ensure_git(app, control, parent)?;
    let directory = parent.join(FOLDER);
    if !directory.join(".git").is_dir() {
        if directory.exists() && fs::read_dir(&directory).map_err(|e| e.to_string())?.next().is_some() {
            return Err("Папка AMDGPU Forge занята другими файлами. Выберите другую папку установки.".into());
        }
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        installer::run_logged(app, control, "git", &["init".into()], &directory, None)?;
        installer::run_logged(app, control, "git", &["remote".into(), "add".into(), "origin".into(), REPOSITORY.into()], &directory, None)?;
    }
    let origin = installer::command_output(app, "git", &["-C".into(), directory.to_string_lossy().into_owned(), "remote".into(), "get-url".into(), "origin".into()])?;
    if origin.trim_end_matches('/').trim_end_matches(".git") != REPOSITORY.trim_end_matches(".git") {
        return Err("В папке AMDGPU Forge находится другой Git-репозиторий.".into());
    }
    if !directory.join("launch.py").is_file() {
        let dirty = installer::command_output(app, "git", &["-C".into(), directory.to_string_lossy().into_owned(), "status".into(), "--porcelain".into()])?;
        if !dirty.is_empty() { return Err("В неполной папке AMDGPU Forge есть локальные изменения.".into()); }
        installer::run_logged(app, control, "git", &["fetch".into(), "--depth".into(), "1".into(), "--progress".into(), "origin".into(), "main".into()], &directory, None)?;
        installer::run_logged(app, control, "git", &["checkout".into(), "-B".into(), "main".into(), "FETCH_HEAD".into()], &directory, None)?;
    }
    let branch = installer::command_output(app, "git", &["-C".into(), directory.to_string_lossy().into_owned(), "branch".into(), "--show-current".into()])?;
    if !branch.is_empty() && branch != "main" { return Err("AMDGPU Forge должен находиться на ветке main.".into()); }
    if !directory.join("modules_forge").is_dir() { return Err("Не найдены исходники AMDGPU Forge.".into()); }
    let uv = crate::managed_tools::ensure_uv(control, parent)?;
    let tools = parent.join(".flow-tools");
    let store = tools.join("python");
    let cache = tools.join("uv-cache");
    let pip_cache = tools.join("pip-cache");
    let python = installer::venv_python(&directory);
    if !python.is_file() {
        installer::notify(app, "venv", "Создание отдельного окружения Python 3.10 для AMD…");
        installer::run_logged_with_env(app, control, &uv.to_string_lossy(), &["venv".into(), "venv".into(), "--python".into(), "3.10".into(), "--seed".into()],
            &directory, &[("UV_PYTHON_INSTALL_DIR", &store), ("UV_CACHE_DIR", &cache)])?;
    }
    let version = installer::command_output(app, &python.to_string_lossy(), &["-c".into(), "import sys; print('%d.%d' % sys.version_info[:2])".into()])?;
    if version != "3.10" { return Err(format!("AMDGPU Forge требует отдельный Python 3.10; найден {version}.")); }
    let env = [("PIP_CACHE_DIR", pip_cache.as_path())];
    installer::notify(app, "dependencies", "Обновление pip и сборщиков AMDGPU Forge…");
    installer::run_logged_retry_locked_env(app, control, &python.to_string_lossy(),
        &["-m".into(), "pip".into(), "install".into(), "--upgrade".into(), "pip".into(), "wheel".into(), "setuptools==69.5.1".into()], &directory, &env)?;
    let req = directory.join(".flow-directml-requirements.txt");
    fs::write(&req, requirements(&fs::read_to_string(directory.join("requirements_versions.txt")).map_err(|e| e.to_string())?)).map_err(|e| e.to_string())?;
    installer::notify(app, "dependencies", "Установка PyTorch DirectML и зависимостей AMDGPU Forge…");
    installer::run_logged_retry_locked_env(app, control, &python.to_string_lossy(), &["-m".into(), "pip".into(), "install".into(), "-r".into(), req.to_string_lossy().into_owned()], &directory, &env)?;
    installer::prepare_local_clip(app, control, &python, &directory)?;
    installer::run_logged_retry_locked_env(app, control, &python.to_string_lossy(), &["-u".into(), "launch.py".into(), "--directml".into(), "--disable-xformers".into(), "--exit".into()],
        &directory, &[("PIP_CACHE_DIR", pip_cache.as_path()), ("REQS_FILE", req.as_path())])?;
    installer::run_logged(app, control, &python.to_string_lossy(), &["-c".into(),
        "import torch, torch_directml as dml, numpy as np; assert dml.device_count() > 0, 'DirectML: no compatible GPU found'; x=torch.from_numpy(np.ones(1,dtype=np.float32)).to(dml.device()); print('DirectML GPU:',dml.device_name(0), 'test:',(x+x).cpu().item())".into()], &directory, None)?;
    if control.is_cancelled() { return Err("Установка отменена.".into()); }
    let revision = installer::command_output(app, "git", &["-C".into(), directory.to_string_lossy().into_owned(), "rev-parse".into(), "--short".into(), "HEAD".into()])?;
    fs::write(directory.join(".flow-installed.json"), serde_json::json!({"name":"WebUI AMDGPU Forge","version":revision,"backend":"directml"}).to_string()).map_err(|e| e.to_string())?;
    crate::activate_amdgpu(app, &directory)?;
    installer::notify(app, "done", "WebUI AMDGPU Forge установлен и готов к запуску.");
    Ok(())
}

#[tauri::command]
pub(crate) async fn install_amdgpu_forge(app: AppHandle, state: State<'_, Arc<InstallControl>>, webui: State<'_, WebuiControl>,
    downloads: State<'_, Arc<crate::civitai::DownloadControl>>, installation_dir: String) -> Result<(), String> {
    if webui.is_running() || downloads.is_running() { return Err("Остановите WebUI и загрузки перед установкой пакета.".into()); }
    let selected = crate::paths::subprocess_path(&PathBuf::from(installation_dir));
    if !selected.is_absolute() || !selected.is_dir() { return Err("Выберите существующую папку установки.".into()); }
    if selected.canonicalize().map_err(|e| e.to_string())? != crate::installation_dir(&app)?.canonicalize().map_err(|e| e.to_string())? {
        return Err("Папка установки изменилась. Повторите выбор.".into());
    }
    state.try_start()?;
    let control = Arc::clone(&*state);
    tauri::async_runtime::spawn_blocking(move || {
        let result = install(&app, &control, &selected);
        control.finish();
        if let Err(error) = result { installer::notify(&app, if control.was_cancelled() { "cancelled" } else { "error" }, error); }
    });
    Ok(())
}

pub(crate) fn launch(app: AppHandle, webui: &WebuiControl) -> Result<(), String> {
    let directory = crate::package_dir(&app)?;
    if !ready(&directory) { return Err("Сначала установите WebUI AMDGPU Forge.".into()); }
    let mut args = arguments(installer::parse_webui_arguments(&crate::webui_arguments(&app)?)?)?;
    installer::disable_browser_autolaunch(&directory, &mut args)?;
    if !args.iter().any(|arg| matches!(arg.as_str(), "--api" | "--listen" | "--share") || arg.starts_with("--api=") || arg.starts_with("--listen=") || arg.starts_with("--share=")) { args.push("--api".into()); }
    let library = crate::models_library_dir(&app)?;
    for (flag, folder) in [("--ckpt-dir", "Stable-diffusion"), ("--lora-dir", "Lora"), ("--vae-dir", "VAE"), ("--embeddings-dir", "embeddings")] {
        if !args.iter().any(|arg| arg == flag || arg.starts_with(&format!("{flag}="))) {
            let path = library.join(folder);
            fs::create_dir_all(&path).map_err(|e| e.to_string())?;
            args.extend([flag.into(), path.to_string_lossy().into_owned()]);
        }
    }
    let req = directory.join(".flow-directml-requirements.txt");
    fs::write(&req, requirements(&fs::read_to_string(directory.join("requirements_versions.txt")).map_err(|e| e.to_string())?)).map_err(|e| e.to_string())?;
    let mut command = Command::new(installer::venv_python(&directory));
    crate::managed_tools::add_git_to_path(&mut command, &crate::installation_dir(&app)?);
    installer::use_local_clip_sources(&mut command, &directory);
    command.arg("-u").arg("launch.py").args(&args).current_dir(&directory)
        .env("REQS_FILE", req).env("PYTHONUNBUFFERED", "1").env("PYTHONIOENCODING", "utf-8:backslashreplace")
        .env("PYTHONFAULTHANDLER", "1").env("WEBUI_LAUNCH_LIVE_OUTPUT", "1")
        .env_remove("COMMANDLINE_ARGS").env_remove("TORCH_COMMAND").env_remove("FLOW_SAFE_MODEL_SWITCH")
        .stdin(Stdio::null());
    installer::start_process(app, webui, "amdgpu-forge".into(), command, None, false, args)
}

#[cfg(test)]
mod tests {
    #[test]
    fn directml_flags_are_unique_and_cuda_backends_rejected() {
        let args = super::arguments(vec!["--api".into()]).unwrap();
        assert_eq!(args.iter().filter(|arg| *arg == "--directml").count(), 1);
        assert_eq!(super::arguments(args.clone()).unwrap(), args);
        assert!(super::arguments(vec!["--directml".into(), "0".into()]).unwrap().contains(&"-1".to_owned()));
        for flag in ["--xformers", "--use-zluda", "--use-directml"] { assert!(super::arguments(vec![flag.into()]).is_err()); }
    }
    #[test]
    fn requirements_keep_directml_torch_and_numpy_compatible() {
        let req = super::requirements("numpy==2.2.6\nblendmodes==2025\ntorch\ngradio==4.40.0\n");
        assert!(req.contains("numpy==1.26.4\n")); assert!(req.contains("torch==2.4.1\n"));
        assert!(req.contains("gradio==4.40.0\n")); assert!(!req.contains("numpy==2"));
    }
}
