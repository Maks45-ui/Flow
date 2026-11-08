use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DisplayDevice {
    pub name: String,
    pub present: Option<bool>,
    pub problem: Option<u32>,
    pub status: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GpuDiagnostics {
    pub manufacturer: String,
    pub model: String,
    pub devices: Vec<DisplayDevice>,
    pub error: Option<String>,
}

#[cfg(windows)]
fn query() -> Result<GpuDiagnostics, String> {
    use std::{io::Read, path::PathBuf, process::{Command, Stdio}, time::{Duration, Instant}};
    // Constant read-only script. Do not include user-controlled paths or serial numbers.
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$result = @{manufacturer='';model='';devices=@();error=$null}
try {
    $system = Get-CimInstance Win32_ComputerSystem
    $result.manufacturer = [string]$system.Manufacturer
    $result.model = [string]$system.Model
    $result.devices = @(Get-PnpDevice -Class Display | Select-Object -First 8 | ForEach-Object {
        $name = [string]$_.FriendlyName
        if ($name.Length -gt 120) { $name = $name.Substring(0,120) }
        @{name=$name;present=$_.Present;problem=[int]$_.Problem;status=[string]$_.Status}
    })
} catch {
    $message = [string]$_.Exception.Message
    $result.error = $message.Substring(0,[Math]::Min(300,$message.Length))
}
$result | ConvertTo-Json -Compress -Depth 4
"#;
    let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let mut command = Command::new(root.join("System32/WindowsPowerShell/v1.0/powershell.exe"));
    command.args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    crate::installer::hide_console(&mut command);
    let mut child = command.spawn().map_err(|error| format!("Проверка устройств GPU недоступна: {error}"))?;
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() { return Err("Проверка устройств GPU завершилась с ошибкой.".into()); }
                break;
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Проверка устройств GPU превысила 15 секунд.".into());
            }
        }
    }
    // Bound the parsed response as well as the script's device count.
    let mut output = Vec::new();
    child.stdout.take().ok_or("Нет ответа проверки GPU.")?.take(16_384).read_to_end(&mut output)
        .map_err(|error| error.to_string())?;
    serde_json::from_slice(&output).map_err(|error| format!("Не удалось прочитать результат проверки GPU: {error}"))
}

#[cfg(not(windows))]
fn query() -> Result<GpuDiagnostics, String> {
    Err("Проверка устройств Windows доступна только в Windows.".into())
}

#[tauri::command]
pub(crate) async fn get_gpu_diagnostics() -> Result<GpuDiagnostics, String> {
    tauri::async_runtime::spawn_blocking(query).await.map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    #[test]
    fn retains_missing_device_code_without_conflating_it_with_present_intel() {
        let info: super::GpuDiagnostics = serde_json::from_str(r#"{"manufacturer":"ASUSTeK","model":"TUF F15","error":null,"devices":[{"name":"NVIDIA RTX 3050","present":false,"problem":45,"status":"Unknown"},{"name":"Intel Iris Xe","present":true,"problem":0,"status":"OK"}]}"#).unwrap();
        assert_eq!(info.devices[0].present, Some(false));
        assert_eq!(info.devices[0].problem, Some(45));
        assert_eq!(info.devices[1].present, Some(true));
        let serialized = serde_json::to_value(info).unwrap();
        assert!(serialized.get("serialNumber").is_none());
    }
}
