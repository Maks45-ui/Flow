import type { PackageInfo } from "./types";

export function localComfyUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Разрешён только локальный адрес ComfyUI.");
  }
  return url.href;
}

function node<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing ${id}`);
  return element as T;
}

/** A bounded iframe keeps ComfyUI's canvas inside Home, never in the page flow. */
export class ComfyHome {
  private readonly frame = node<HTMLIFrameElement>("comfy-frame");
  private readonly overview = node<HTMLElement>("home-overview");
  private readonly panel = node<HTMLElement>("comfy-panel");
  private readonly overviewButton = node<HTMLButtonElement>("home-overview-tab");
  private readonly comfyButton = node<HTMLButtonElement>("home-comfy-tab");
  private readonly status = node<HTMLElement>("comfy-status");
  private url: string | null = null;
  private generation = 0;
  private loadTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly showHome: () => void, stop: () => void, restart: () => void,
    private readonly checkFrame: () => Promise<number>) {
    this.overviewButton.addEventListener("click", () => this.showOverview());
    this.comfyButton.addEventListener("click", () => { if (this.url) this.open(this.url); });
    node("comfy-reload").addEventListener("click", () => { void this.load(); });
    node("comfy-stop").addEventListener("click", stop);
    node("comfy-restart").addEventListener("click", restart);
  }

  showOverview(): void {
    this.overview.hidden = false;
    this.panel.hidden = true;
    this.overviewButton.setAttribute("aria-selected", "true");
    this.comfyButton.setAttribute("aria-selected", "false");
  }

  open(raw: string): void {
    const url = localComfyUrl(raw);
    this.url = url;
    if (this.frame.getAttribute("src") !== url) void this.load();
    this.comfyButton.disabled = false;
    this.overview.hidden = true;
    this.panel.hidden = false;
    this.overviewButton.setAttribute("aria-selected", "false");
    this.comfyButton.setAttribute("aria-selected", "true");
    this.showHome();
  }

  private clearLoadTimer(): void {
    if (this.loadTimer !== null) clearTimeout(this.loadTimer);
    this.loadTimer = null;
  }

  private showStatus(message: string): void {
    this.status.textContent = message;
    this.status.hidden = false;
    this.frame.hidden = true;
  }

  private async load(): Promise<void> {
    const url = this.url;
    if (!url) return;
    const generation = ++this.generation;
    this.clearLoadTimer();
    this.showStatus("Проверяем встроенное подключение к ComfyUI…");
    try {
      const code = await this.checkFrame();
      if (generation !== this.generation || url !== this.url) return;
      if (code === 403) throw new Error("ComfyUI запретил встроенное открытие (HTTP 403). Нажмите «Перезапустить», чтобы применить интеграцию Flow.");
      if (code < 200 || code >= 300) throw new Error(`ComfyUI вернул ошибку HTTP ${code}.`);
      this.status.textContent = "Загружаем редактор ComfyUI…";
      const failed = () => {
        if (generation === this.generation) {
          this.clearLoadTimer();
          this.showStatus("Не удалось загрузить редактор ComfyUI. Нажмите «Обновить» или проверьте логи сервера.");
        }
      };
      this.frame.onload = () => {
        if (generation !== this.generation || this.frame.getAttribute("src") !== url) return;
        this.clearLoadTimer();
        this.status.hidden = true;
        this.frame.hidden = false;
      };
      this.frame.onerror = failed;
      this.loadTimer = setTimeout(failed, 15_000);
      this.frame.src = url;
    } catch (error: unknown) {
      if (generation !== this.generation) return;
      this.clearLoadTimer();
      this.frame.removeAttribute("src");
      this.showStatus(error instanceof Error ? error.message : String(error));
    }
  }

  sync(packages: readonly PackageInfo[]): void {
    const running = packages.find(item => item.id === "comfyui" && item.running && !item.stopping);
    this.comfyButton.disabled = !running?.readyUrl;
    if (!running?.readyUrl) {
      ++this.generation;
      this.clearLoadTimer();
      this.url = null;
      this.frame.removeAttribute("src");
      this.showOverview();
    } else {
      this.url = localComfyUrl(running.readyUrl);
    }
  }
}
