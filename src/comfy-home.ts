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
  private url: string | null = null;

  constructor(private readonly showHome: () => void, stop: () => void, restart: () => void) {
    this.overviewButton.addEventListener("click", () => this.showOverview());
    this.comfyButton.addEventListener("click", () => { if (this.url) this.open(this.url); });
    node("comfy-reload").addEventListener("click", () => { if (this.url) this.frame.src = this.url; });
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
    if (this.url !== url || !this.frame.hasAttribute("src")) this.frame.src = url;
    this.url = url;
    this.comfyButton.disabled = false;
    this.overview.hidden = true;
    this.panel.hidden = false;
    this.overviewButton.setAttribute("aria-selected", "false");
    this.comfyButton.setAttribute("aria-selected", "true");
    this.showHome();
  }

  sync(packages: readonly PackageInfo[]): void {
    const running = packages.find(item => item.id === "comfyui" && item.running && !item.stopping);
    this.comfyButton.disabled = !running?.readyUrl;
    if (!running?.readyUrl) {
      this.url = null;
      this.frame.removeAttribute("src");
      this.showOverview();
    }
  }
}
