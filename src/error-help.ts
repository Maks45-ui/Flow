import { version } from "../package.json";
import type { AppState, FlowAPI, PackageInfo, TaskEvent } from "./types";
import { buildDiagnosticReport, diagnose, DiagnosticHistory, redactDiagnostics } from "./diagnostics";
import type { DiagnosticIncident, DiagnosticScope } from "./diagnostics";

const scopes: Partial<Record<keyof FlowAPI, DiagnosticScope>> = {
  installForgeNeo: "install", installXformers: "install", repairPackage: "install", updatePackage: "install", rollbackPackage: "install",
  launchWebUI: "launch", stopWebUI: "launch", openWebUI: "launch", checkXformers: "install",
  searchModels: "catalog", getStarterModel: "catalog", saveCivitaiToken: "catalog", saveOnboardingToken: "catalog",
  downloadModel: "download", pauseDownload: "download", cancelDownload: "download", listDownloads: "download", deleteDownload: "download"
};
const starts = new Set<keyof FlowAPI>(["installForgeNeo", "installXformers", "repairPackage", "updatePackage", "rollbackPackage", "launchWebUI", "searchModels", "downloadModel"]);
const passive = new Set<keyof FlowAPI>(["getState", "getWebUIStatus", "getPreview", "setPage", "onTask", "getPreflight", "openDiagnosticSource"]);
const errorText = (error: unknown): string => error instanceof Error ? error.message : typeof error === "string" ? error : "Произошла неизвестная ошибка.";
const scopeForTask = (event: TaskEvent): DiagnosticScope => event.kind === "xformers" ? "install" : event.kind;
const cancelled = (message: string): boolean => /^(?:установка|загрузка) (?:отменена|приостановлена)\.?$/i.test(message.trim());

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function required<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Не найден элемент диагностики: ${id}`);
  return el as T;
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Проверка окружения не завершилась за 8 секунд.")), 8000); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

class ErrorHelpController {
  private readonly history = new DiagnosticHistory();
  private readonly active = new Set<DiagnosticScope>();
  private packageId: PackageInfo["id"] = "automatic1111";
  private readonly operationPackages = new Map<DiagnosticScope, PackageInfo["id"]>();
  private incidentPackage: PackageInfo["id"] = "automatic1111";
  private generation = 0;
  private readonly dialog = required<HTMLDialogElement>("error-help-dialog");
  private readonly findings = required<HTMLElement>("error-help-findings");
  private readonly report = required<HTMLTextAreaElement>("error-help-report");
  private readonly status = required<HTMLElement>("error-help-status");
  private readonly copy = required<HTMLButtonElement>("copy-error-report");
  private readonly toast = required<HTMLElement>("toast");
  private readonly toastHelp = node("button", "diagnostics-toast-help", "Разобраться");
  private readonly buttons = [required<HTMLButtonElement>("console-error-help"), required<HTMLButtonElement>("settings-error-help")];

  constructor(private readonly api: FlowAPI) {
    this.toastHelp.type = "button";
    this.toastHelp.addEventListener("click", () => { void this.open(); });
    for (const button of this.buttons) button.addEventListener("click", () => { void this.open(); });
    required<HTMLButtonElement>("close-error-help").addEventListener("click", () => this.dialog.close());
    required<HTMLButtonElement>("dismiss-error-help").addEventListener("click", () => this.dialog.close());
    this.dialog.addEventListener("close", () => { this.generation += 1; });
    this.copy.addEventListener("click", () => {
      // Copy the reviewed text, with one more redaction pass. Never send it anywhere.
      this.report.value = redactDiagnostics(this.report.value);
      if (!navigator.clipboard?.writeText) { this.selectReport(); return; }
      void navigator.clipboard.writeText(this.report.value).then(() => { this.status.textContent = "Отчёт скопирован. Проверьте его перед отправкой."; }).catch(() => this.selectReport());
    });
    new MutationObserver(() => this.attachToastAction()).observe(this.toast, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    void api.onTask(event => this.recordTask(event)).catch(() => {
      required<HTMLElement>("error-help-summary").textContent = "Поток логов недоступен; помощь для ошибок команд остаётся доступна.";
    });
  }

  setPackage(state: AppState): void {
    const active = state.packages.find(item => item.active);
    if (active) this.packageId = active.id;
  }

  begin(scope: DiagnosticScope, method?: keyof FlowAPI, args: readonly unknown[] = []): void {
    this.history.begin(scope);
    this.active.add(scope);
    const explicit = method === "installForgeNeo" ? "forge-neo" : args[0];
    this.operationPackages.set(scope, explicit === "forge-neo" || explicit === "automatic1111" ? explicit : this.packageId);
  }

  capture(scope: DiagnosticScope, message: string): void {
    if (cancelled(message)) return;
    const incident = this.history.capture(scope, message);
    this.incidentPackage = this.operationPackages.get(scope) ?? this.packageId;
    for (const button of this.buttons) { button.disabled = false; button.title = "Разобрать последнюю ошибку"; }
    required<HTMLElement>("error-help-summary").textContent = incident.matches.length ? "Для последней ошибки найдено объяснение. Разбор выполняется локально." : "Есть ошибка для разбора. Если правило не найдено, можно подготовить отчёт.";
    this.attachToastAction();
  }

  private recordTask(event: TaskEvent): void {
    const scope = scopeForTask(event);
    if (!this.active.has(scope) && !["done", "error", "cancelled", "paused"].includes(event.phase)) this.begin(scope);
    this.history.record(scope, event.message);
    if (event.phase === "error" || event.phase === "model_error" || (event.phase === "log" && diagnose(scope, event.message, []).length > 0)) this.capture(scope, event.message);
    if (["done", "error", "cancelled", "paused"].includes(event.phase)) this.active.delete(scope);
  }

  private attachToastAction(): void {
    const incident = this.history.latest;
    const message = redactDiagnostics([...this.toast.childNodes].filter(child => child !== this.toastHelp).map(child => child.textContent ?? "").join("")).trim();
    const matches = incident && (message === incident.message || message.endsWith(`: ${incident.message}`));
    if (matches && this.toast.classList.contains("visible")) {
      if (this.toastHelp.parentNode !== this.toast) this.toast.append(this.toastHelp);
    } else if (this.toastHelp.parentNode) this.toastHelp.remove();
  }

  private selectReport(): void {
    this.report.focus(); this.report.select();
    this.status.textContent = "Буфер обмена недоступен. Скопируйте выделенный отчёт вручную (Ctrl+C).";
  }

  private renderFindings(incident: DiagnosticIncident): void {
    this.findings.replaceChildren();
    if (!incident.matches.length) {
      const card = node("section", "diagnostic-card");
      card.append(node("h3", "", "Причина пока не установлена"), node("p", "", "В локальной базе нет подходящего правила. Flow не будет угадывать причину или менять файлы. Проверьте сообщение и подготовьте отчёт ниже."));
      this.findings.append(card);
      return;
    }
    for (const {rule, evidence} of incident.matches) {
      const card = node("section", "diagnostic-card");
      const fact = node("p", "diagnostic-fact", `Факт: ${rule.fact}`);
      const list = node("ol", "diagnostic-steps");
      for (const step of rule.steps) list.append(node("li", "", step));
      const details = node("details", "diagnostic-evidence");
      details.append(node("summary", "", "Фрагмент сообщения и применимость"), node("pre", "", evidence), node("p", "", rule.appliesTo));
      const source = node("button", "text-link diagnostic-source", `${rule.source.label} ↗`);
      source.type = "button";
      source.addEventListener("click", () => { void this.api.openDiagnosticSource(rule.source.url).catch(() => { this.status.textContent = "Не удалось открыть источник. Его адрес есть в отчёте."; }); });
      const footer = node("div", "diagnostic-card-footer");
      footer.append(source, node("span", "", `Проверено: ${rule.checkedOn}`));
      card.append(node("h3", "", rule.title), fact, node("p", "", `Возможная причина: ${rule.cause}`), node("h4", "", "Что можно проверить"), list, details, footer);
      this.findings.append(card);
    }
  }

  private async open(): Promise<void> {
    const incident = this.history.latest;
    if (!incident) return;
    const packageId = this.incidentPackage;
    const generation = ++this.generation;
    this.renderFindings(incident);
    required<HTMLElement>("error-help-message").textContent = incident.message;
    this.report.value = "Собираем доступные сведения об окружении…";
    this.copy.disabled = true;
    this.report.disabled = true;
    this.status.textContent = "Проверяем окружение локально. Это не запускает установку или ремонт.";
    if (!this.dialog.open) this.dialog.showModal();
    const results = await Promise.allSettled([bounded(this.api.getState()), bounded(this.api.getPreflight(packageId)), bounded(this.api.getWebUIStatus())]);
    if (generation !== this.generation || !this.dialog.open) return;
    const environment = [`Flow: ${version}`, `Платформа WebView: ${navigator.platform}`, `Пакет ошибки: ${packageId}`];
    const [state, checks, webui] = results;
    if (state?.status === "fulfilled") {
      const pkg = state.value.packages.find(item => item.id === packageId);
      environment.push(pkg ? `Пакет: ${pkg.name}; версия: ${pkg.version}; управляется Flow: ${pkg.managed ? "да" : "нет"}` : "Пакет ещё не установлен или не найден.");
    } else environment.push("Состояние пакета недоступно.");
    if (checks?.status === "fulfilled") for (const check of checks.value.checks) environment.push(`${check.label}: ${check.value} [${check.level}]`);
    else environment.push("Проверки окружения недоступны или превысили время ожидания.");
    if (webui?.status === "fulfilled") {
      environment.push(`Локальный WebUI сейчас: ${webui.value.running ? "запущен" : "остановлен"}`);
      if (webui.value.vramTotalGb !== null) environment.push(`VRAM сейчас: ${webui.value.vramUsedGb ?? "?"} / ${webui.value.vramTotalGb} ГБ`);
    }
    this.report.value = buildDiagnosticReport(incident, environment);
    this.report.disabled = false;
    this.copy.disabled = false;
    this.status.textContent = "Отчёт готов. Он никуда не отправлен. Проверьте и при необходимости отредактируйте текст перед копированием.";
  }
}

/** One boundary for rejected commands and task logs; existing callers keep their contract. */
export function withErrorHelp(api: FlowAPI): FlowAPI {
  const controller = new ErrorHelpController(api);
  return new Proxy(api, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || typeof property !== "string") return value;
      const method = property as keyof FlowAPI;
      return (...args: unknown[]) => {
        const scope = scopes[method] ?? "general";
        if (starts.has(method)) controller.begin(scope, method, args);
        return Promise.resolve().then(() => Reflect.apply(value, target, args) as unknown).then(result => {
          if (method === "getState") controller.setPackage(result as AppState);
          return result;
        }).catch((error: unknown) => {
          if (!passive.has(method)) controller.capture(scope, errorText(error));
          throw error;
        });
      };
    }
  });
}
