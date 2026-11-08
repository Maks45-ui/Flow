/** Offline rules: no requests, installs, settings changes or automatic fixes. */
export type DiagnosticScope = "install" | "launch" | "download" | "catalog" | "general";

export interface DiagnosticRule {
  id: string;
  title: string;
  fact: string;
  cause: string;
  steps: readonly string[];
  source: { label: string; url: string };
  checkedOn: string;
  appliesTo: string;
  scopes?: readonly DiagnosticScope[];
  pattern: RegExp;
}

const checkedOn = "2026-11-04";
const civitaiSource = { label: "Civitai · коды ошибок API", url: "https://developer.civitai.com/site/guide/errors" };
export const DIAGNOSTIC_RULES: readonly DiagnosticRule[] = [
  {
    id: "cuda-driver", title: "Драйвер не поддерживает установленную CUDA",
    fact: "PyTorch сообщил о несовместимом или слишком старом видеодрайвере.",
    cause: "Версия драйвера не подходит установленной сборке PyTorch/CUDA. Переустановка той же сборки PyTorch сама по себе это не исправляет.",
    steps: ["Проверьте версию драйвера NVIDIA и версию CUDA в установленном PyTorch.", "Для CUDA 13.x требуется драйвер ветки 580 или новее. Обновите подходящий драйвер NVIDIA и перезагрузите Windows.", "Повторите установку пакета в той же папке после восстановления доступа к GPU."],
    source: { label: "NVIDIA · совместимость CUDA и драйверов", url: "https://docs.nvidia.com/deploy/cuda-compatibility/minor-version-compatibility.html" },
    checkedOn: "2026-11-08", appliesTo: "Явные сообщения CUDA/PyTorch о несовместимом драйвере.", scopes: ["install", "launch"],
    pattern: /(?:CUDA driver version is insufficient|NVIDIA driver.*too old|driver on your system is too old|Please update your GPU driver or manually install older version of PyTorch)/i
  },
  {
    id: "gpu-unavailable", title: "PyTorch не видит доступную видеокарту",
    fact: "Проверка GPU завершилась ошибкой до загрузки модели.",
    cause: "Видеокарта может быть отключена режимом энергосбережения, недоступна Windows или не работать с текущим драйвером. По одной строке ошибки точную причину определить нельзя.",
    steps: ["Проверьте состояние видеокарты в результатах проверки устройств ниже.", "На ноутбуке подключите питание и проверьте режим дискретной видеокарты в фирменной утилите.", "Если видеокарта подключена без ошибок, проверьте её драйвер и совместимость со сборкой PyTorch/CUDA.", "После восстановления доступа к GPU продолжите установку в той же папке. Уже скачанные файлы сохранятся."],
    source: { label: "Microsoft · коды устройств Windows", url: "https://support.microsoft.com/en-gb/windows/hardware/drivers/error-codes-in-device-manager-in-windows" },
    checkedOn: "2026-11-08", appliesTo: "Forge Neo, ComfyUI и PyTorch; ошибка доступности GPU, не CUDA OutOfMemory.", scopes: ["install", "launch"],
    pattern: /(?:PyTorch is not able to access any compute device\s*\(GPU\)|No CUDA GPUs are available|Found no NVIDIA driver on your system|ComfyUI requires a working NVIDIA CUDA driver)/i
  },
  {
    id: "cuda-memory", title: "Не хватило видеопамяти",
    fact: "Обнаружена сигнатура ошибки CUDA OutOfMemory.",
    cause: "Текущей операции не хватило доступной памяти GPU. Это не доказывает неисправность видеокарты.",
    steps: ["Проверьте загрузку GPU другими программами и закройте ненужные приложения.", "Для генерации попробуйте меньший размер изображения и batch size 1 в WebUI.", "Для AUTOMATIC1111 проверьте профиль экономии памяти в настройках запуска Flow; аргументы A1111 не следует автоматически переносить в Forge."],
    source: { label: "PyTorch · управление памятью CUDA", url: "https://docs.pytorch.org/docs/stable/notes/cuda.html#memory-management" },
    checkedOn, appliesTo: "PyTorch/CUDA; профили запуска зависят от WebUI.",
    pattern: /(?:CUDA(?:\s+error:)?\s*:?\s*out of memory|torch\.(?:cuda\.)?OutOfMemoryError)/i
  },
  {
    id: "windows-commit", title: "Windows достигла лимита выделяемой памяти",
    fact: "Обнаружена ошибка Windows 1455 / ERROR_COMMITMENT_LIMIT.",
    cause: "Недостаточно доступного системного commit: учитываются RAM и файл подкачки. Это не то же самое, что нехватка VRAM.",
    steps: ["В Диспетчере задач откройте «Производительность → Память» и проверьте значение «Выделено».", "Закройте ненужные приложения, использующие много памяти.", "Проверьте настройки виртуальной памяти Windows и свободное место для файла подкачки. Не отключайте его; изменение размера может потребовать перезапуска Windows."],
    source: { label: "Microsoft · ERROR_COMMITMENT_LIMIT (1455)", url: "https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--1300-1699-" },
    checkedOn, appliesTo: "Windows; код системной ошибки 1455.",
    pattern: /(?:(?:winerror|os error|error code|код ошибки)\s*[:\[(]?\s*1455\b|ERROR_COMMITMENT_LIMIT|paging file is too small|файл подкачки слишком мал)/i
  },
  {
    id: "disk-full", title: "Не хватает места на диске",
    fact: "Обнаружена ошибка переполнения диска (ENOSPC / Windows 112).",
    cause: "На диске, куда выполняется запись, могло закончиться свободное место. Папка моделей, временная папка и системный диск могут находиться на разных дисках.",
    steps: ["Проверьте свободное место на диске установки, в библиотеке моделей и на системном диске.", "Освобождайте место только после проверки файлов; Flow ничего не удаляет самостоятельно.", "После освобождения места повторите действие. Не удаляйте незавершённую загрузку без необходимости — она может поддерживать продолжение."],
    source: { label: "Microsoft · ERROR_DISK_FULL (112)", url: "https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--0-499-" },
    checkedOn, appliesTo: "Windows 112 и сообщения ENOSPC при записи файлов.",
    pattern: /(?:no space left on device|\bdisk (?:is )?full\b|\bENOSPC\b|(?:winerror|os error)\s*[:\[(]?\s*112\b|недостаточно места на диске)/i
  },
  {
    id: "civitai-auth", title: "Civitai не принял авторизацию",
    fact: "Запрос к Civitai завершился HTTP 401.",
    cause: "Для этого запроса может требоваться действующий ключ или сеанс. Само сообщение не позволяет определить, отсутствует ключ или он больше не действует.",
    steps: ["Проверьте, сохранён ли API-ключ в настройках Flow; не вставляйте его в отчёт или чат.", "Войдите в свой аккаунт Civitai и проверьте доступ к нужной модели.", "При необходимости замените ключ в настройках Flow и повторите запрос."],
    source: civitaiSource, checkedOn, appliesTo: "Civitai API; только каталог и загрузки Civitai.", scopes: ["catalog", "download"],
    pattern: /(?:\b401\s*\(Unauthorized\)|\bHTTP(?:\/\d(?:\.\d)?)?\s*[: ]\s*401\b|status(?: code)?\s*[:=(]?\s*401\b|\b401 Unauthorized\b)/i
  },
  {
    id: "civitai-forbidden", title: "Civitai ограничил доступ к ресурсу",
    fact: "Запрос к Civitai завершился HTTP 403.",
    cause: "HTTP 403 сообщает об отказе в доступе; он сам по себе не доказывает, что API-ключ неверный. Нужно проверить права аккаунта и ответ сервиса.",
    steps: ["Откройте страницу модели в браузере под тем же аккаунтом и проверьте условия доступа.", "Если в ответе упомянута защита Cloudflare, дождитесь восстановления доступа; не пытайтесь обходить ограничения.", "Не повторяйте запрос непрерывно и не меняйте ключ без дополнительных признаков проблемы с авторизацией."],
    source: civitaiSource, checkedOn, appliesTo: "Civitai API/защита сервиса; только каталог и загрузки.", scopes: ["catalog", "download"],
    pattern: /(?:\b403\s*\(Forbidden\)|\bHTTP(?:\/\d(?:\.\d)?)?\s*[: ]\s*403\b|status(?: code)?\s*[:=(]?\s*403\b|\b403 Forbidden\b)/i
  },
  {
    id: "civitai-rate-limit", title: "Civitai отклонил запрос с кодом 429",
    fact: "Обнаружен HTTP 429 Too Many Requests.",
    cause: "Возможны ограничения частоты запросов или лимит пагинации API. Без ответа сервера различить их нельзя.",
    steps: ["Подождите перед повторным запросом и не нажимайте кнопку поиска многократно.", "Если ошибка возникает при пролистывании каталога, сохраните отчёт: причиной может быть лимит пагинации.", "Повторяющиеся ошибки передайте вместе с отчётом; замена API-ключа не является универсальным решением."],
    source: civitaiSource, checkedOn, appliesTo: "Civitai API; каталог и загрузки.", scopes: ["catalog", "download"],
    pattern: /(?:\b429\s*\(Too Many Requests\)|\bHTTP(?:\/\d(?:\.\d)?)?\s*[: ]\s*429\b|status(?: code)?\s*[:=(]?\s*429\b|\b429 Too Many Requests\b)/i
  },
  {
    id: "request-timeout", title: "Истекло время ожидания запроса",
    fact: "Обнаружено сообщение о таймауте сетевого запроса.",
    cause: "Соединение или ответ не уложились в лимит времени. Причиной может быть сеть, сервер либо общий таймаут клиента; отсутствие интернета этим не доказано.",
    steps: ["Проверьте доступность сервиса из сообщения и настройки сети/прокси.", "Повторите действие позже. Для модели используйте «Повторить» или «Продолжить», если они доступны.", "Если большая модель каждый раз обрывается через одинаковое время, приложите отчёт: потребуется проверить таймаут загрузчика Flow."],
    source: { label: "reqwest 0.12 · таймаут запроса", url: "https://docs.rs/reqwest/0.12/reqwest/blocking/struct.ClientBuilder.html#method.timeout" },
    checkedOn, appliesTo: "Сетевые запросы установщика и Civitai; не локальная генерация.", scopes: ["install", "catalog", "download"],
    pattern: /(?:\btimed? out\b|\btimeout\b|истекло время ожидания|превышено время ожидания)/i
  }
];

/** Defense in depth, not a guarantee: the user reviews the editable report. */
export function redactDiagnostics(raw: string): string {
  return raw
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/https?:\/\/[^\s<>"']+/gi, (text) => {
      try {
        const url = new URL(text);
        const privateParts = Boolean(url.username || url.password || url.search || url.hash);
        return `${url.protocol}//${url.host}${url.pathname}${privateParts ? "?[СКРЫТО]" : ""}`;
      } catch { return "[URL СКРЫТ]"; }
    })
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "[АВТОРИЗАЦИЯ СКРЫТА]")
    .replace(/((?:["']?(?:authorization|civitai[_-]?(?:api[_-]?)?(?:key|token)|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, "$1[СКРЫТО]")
    .replace(/(--(?:api-key|token|password|secret)\s+)(?:"[^"]*"|'[^']*'|\S+)/gi, "$1[СКРЫТО]")
    .replace(/\b[A-Z]:[\\/]Users[\\/][^\\/\r\n"']+/gi, "[ПАПКА ПОЛЬЗОВАТЕЛЯ]")
    .replace(/\/(?:home|Users)\/[^/\r\n"']+/g, "[ПАПКА ПОЛЬЗОВАТЕЛЯ]")
    .replace(/\\\\[^\\\s]+\\[^\\\s]+/g, "[СЕТЕВАЯ ПАПКА]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[EMAIL СКРЫТ]")
    .replace(/^.*(?:negative[_ ]?prompt|\bprompt)\s*[:=].*$/gim, "[ТЕКСТ ГЕНЕРАЦИИ СКРЫТ]")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

export interface DiagnosticMatch { rule: DiagnosticRule; evidence: string; }
export function diagnose(scope: DiagnosticScope, message: string, lines: readonly string[]): DiagnosticMatch[] {
  const applicable = DIAGNOSTIC_RULES.filter(rule => !rule.scopes || rule.scopes.includes(scope));
  const match = (input: readonly string[]) => applicable.flatMap(rule => {
    const evidence = [...input].reverse().find(line => rule.pattern.test(line));
    return evidence ? [{ rule, evidence: redactDiagnostics(evidence).slice(0, 400) }] : [];
  }).slice(0, 3);
  // An explicit current error wins over older context from the same operation.
  const current = match([message]);
  return current.length ? current : match(lines.slice(-80));
}

export interface DiagnosticIncident {
  scope: DiagnosticScope;
  message: string;
  occurredAt: string;
  lines: readonly string[];
  matches: readonly DiagnosticMatch[];
}

/** Prefer the actual traceback/pip error over a wrapper such as exit code 1. */
export function primaryErrorMessage(incident: DiagnosticIncident): string {
  return incident.matches[0]?.evidence ?? [...incident.lines].reverse()
    .find(line => /\b(?:[\w.]+(?:Error|Exception)|ERROR|fatal):/i.test(line)) ?? incident.message;
}

export class DiagnosticHistory {
  private readonly logs = new Map<DiagnosticScope, string[]>();
  latest: DiagnosticIncident | null = null;

  begin(scope: DiagnosticScope): void { this.logs.set(scope, []); }

  record(scope: DiagnosticScope, message: string): void {
    const lines = this.logs.get(scope) ?? [];
    lines.push(...redactDiagnostics(message).slice(-20_000).split(/\r?\n/).filter(Boolean).map(line => line.slice(0, 1500)));
    this.logs.set(scope, lines.slice(-120));
  }

  capture(scope: DiagnosticScope, message: string): DiagnosticIncident {
    const safeMessage = redactDiagnostics(message).slice(-6000);
    const lines = [...(this.logs.get(scope) ?? [])];
    const matches = diagnose(scope, safeMessage, lines);
    return this.latest = { scope, message: safeMessage, lines, matches, occurredAt: new Date().toISOString() };
  }
}

export function buildDiagnosticReport(incident: DiagnosticIncident, environment: readonly string[]): string {
  const findings = incident.matches.length ? incident.matches.map(({rule, evidence}) =>
    [`Правило: ${rule.id} — ${rule.title}`, `Обнаружено: ${rule.fact}`, `Фрагмент: ${evidence}`, `Возможная причина: ${rule.cause}`, `Применимость: ${rule.appliesTo}`, `Проверено: ${rule.checkedOn}`, `Источник: ${rule.source.url}`, ...rule.steps.map((step,i) => `${i + 1}. ${step}`)].join("\n")
  ).join("\n\n") : "Подходящее правило не найдено. Причина не установлена; автоматических исправлений нет.";
  return redactDiagnostics([
    "Flow · локальный отчёт об ошибке", `Время: ${incident.occurredAt}`, `Этап: ${incident.scope}`,
    "", "СООБЩЕНИЕ", incident.message, "", "ОКРУЖЕНИЕ (на момент проверки)", ...environment,
    "", "РАЗБОР", findings, "", "ПОСЛЕДНИЕ СТРОКИ ТЕКУЩЕЙ ОПЕРАЦИИ", ...incident.lines,
    "", "Отчёт создан локально. Секреты скрываются по шаблонам; перед передачей проверьте текст."
  ].join("\n")).slice(0, 60_000);
}
