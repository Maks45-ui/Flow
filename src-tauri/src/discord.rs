#[cfg(windows)]
mod windows {
    use serde_json::json;
    use std::{fs::{File, OpenOptions}, io::{self, Read, Write}, sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Mutex, OnceLock}, time::{SystemTime, UNIX_EPOCH}};

    const CLIENT_ID: &str = "1559517880825942036";
    static CONNECTION: OnceLock<Mutex<Option<File>>> = OnceLock::new();
    static STARTED: OnceLock<u64> = OnceLock::new();
    static REQUEST_ID: AtomicU64 = AtomicU64::new(0);
    static BUTTONS_ENABLED: AtomicBool = AtomicBool::new(true);

    fn send_frame(pipe: &mut File, opcode: u32, payload: serde_json::Value) -> std::io::Result<()> {
        let data = payload.to_string();
        pipe.write_all(&opcode.to_le_bytes())?;
        pipe.write_all(&(data.len() as u32).to_le_bytes())?;
        pipe.write_all(data.as_bytes())
    }

    fn read_frame(pipe: &mut File) -> io::Result<(u32, serde_json::Value)> {
        let mut header = [0_u8; 8];
        pipe.read_exact(&mut header)?;
        let opcode = u32::from_le_bytes(header[..4].try_into().unwrap());
        let length = u32::from_le_bytes(header[4..].try_into().unwrap()) as usize;
        if length > 1024 * 1024 { return Err(io::Error::new(io::ErrorKind::InvalidData, "Discord RPC frame is too large")); }
        let mut body = vec![0_u8; length];
        pipe.read_exact(&mut body)?;
        let payload = serde_json::from_slice(&body).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        Ok((opcode, payload))
    }

    fn read_response(pipe: &mut File, nonce: Option<&str>) -> io::Result<serde_json::Value> {
        for _ in 0..8 {
            let (opcode, payload) = read_frame(pipe)?;
            if opcode == 3 {
                send_frame(pipe, 4, payload)?;
                continue;
            }
            if opcode != 1 { return Err(io::Error::new(io::ErrorKind::InvalidData, "Unexpected Discord RPC opcode")); }
            if nonce.is_some_and(|expected| payload["nonce"].as_str() != Some(expected)) { continue; }
            return Ok(payload);
        }
        Err(io::Error::new(io::ErrorKind::InvalidData, "Discord RPC response was not received"))
    }

    fn send_activity(pipe: &mut File, activity: &serde_json::Value, started: u64) -> io::Result<bool> {
        let nonce = format!("{started}-{}", REQUEST_ID.fetch_add(1, Ordering::Relaxed));
        let payload = json!({"cmd": "SET_ACTIVITY", "args": {"pid": std::process::id(), "activity": activity}, "nonce": nonce.clone()});
        send_frame(pipe, 1, payload)?;
        let response = read_response(pipe, Some(&nonce))?;
        if response["evt"] == "ERROR" {
            eprintln!("Discord RPC rejected activity: {}", response["data"]["message"]);
            return Ok(false);
        }
        Ok(response["cmd"] == "SET_ACTIVITY")
    }

    fn connect() -> Option<File> {
        for index in 0..10 {
            let path = format!(r"\\.\pipe\discord-ipc-{index}");
            if let Ok(mut pipe) = OpenOptions::new().read(true).write(true).open(path) {
                if send_frame(&mut pipe, 0, json!({"v": 1, "client_id": CLIENT_ID})).is_ok()
                    && read_response(&mut pipe, None).is_ok_and(|response| response["evt"] == "READY") {
                    return Some(pipe);
                }
            }
        }
        None
    }

    pub(super) fn set_page(page: &str) {
        let page = page.to_owned();
        std::thread::spawn(move || {
            let state = match page.as_str() {
                "home" => "Главная", "gallery" => "Просмотр галереи",
                "models" => "Загрузка моделей", "manage-models" => "Управление моделями",
                "settings" => "В настройках", _ => return,
            };
            let started = *STARTED.get_or_init(|| SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs());
            let connection = CONNECTION.get_or_init(|| Mutex::new(None));
            let Ok(mut slot) = connection.lock() else { return };
            if slot.is_none() { *slot = connect(); }
            let Some(pipe) = slot.as_mut() else { return };
            let mut activity = json!({"state": state, "timestamps": {"start": started}});
            if page == "settings" { activity["details"] = json!("Управление Flow"); }
            let mut with_buttons = activity.clone();
            with_buttons["buttons"] = json!([
                {"label": "Discord-сервер", "url": "https://discord.gg/Pn59JvAqUX"},
                {"label": "GitHub", "url": "https://github.com/Maks45-ui/Flow"}
            ]);
            if BUTTONS_ENABLED.load(Ordering::Relaxed) {
                match send_activity(pipe, &with_buttons, started) {
                    Ok(true) => return,
                    Ok(false) => { BUTTONS_ENABLED.store(false, Ordering::Relaxed); },
                    Err(_) => { *slot = connect(); }
                }
            }
            if let Some(pipe) = slot.as_mut() {
                if !matches!(send_activity(pipe, &activity, started), Ok(true)) { *slot = None; }
            }
        });
    }
}

pub(crate) fn set_page(page: &str) {
    #[cfg(windows)] windows::set_page(page);
    #[cfg(not(windows))] let _ = page;
}

