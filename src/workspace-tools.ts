import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { FlowAPI, ModelImportPreview, ModelProfile } from "./types";

function node<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Не найден ${id}`);
  return value as T;
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function size(bytes: number): string { return `${(bytes / 1024 ** 3).toFixed(2)} ГБ`; }

export class WorkspaceTools {
  private queue: string[] = [];
  private source: string | null = null;
  private preview: ModelImportPreview | null = null;
  private importing = false;
  private profiles: ModelProfile[] = [];
  private readonly dialog = node<HTMLDialogElement>("model-import-dialog");
  private readonly model = node<HTMLSelectElement>("profile-model");
  constructor(private readonly api: FlowAPI, private readonly changed: () => void, private readonly notify: (text: string) => void) {
    node("import-model-button").addEventListener("click", () => {
      void api.browseModelFiles().then(paths => this.enqueue(paths)).catch(error => notify(errorText(error)));
    });
    void getCurrentWebview().onDragDropEvent(event => {
      document.body.classList.toggle("model-dragging", event.payload.type === "over" || event.payload.type === "enter");
      if (event.payload.type === "drop") this.enqueue(event.payload.paths);
    }).catch(() => { /* File picker remains available outside Tauri. */ });
    node("model-import-type").addEventListener("change", () => this.importTarget());
    node("cancel-model-import").addEventListener("click", () => { if (!this.importing) this.dialog.close(); });
    this.dialog.addEventListener("cancel", event => { if (this.importing) event.preventDefault(); });
    this.dialog.addEventListener("close", () => { this.source = null; this.preview = null; void this.next(); });
    node("confirm-model-import").addEventListener("click", () => void this.import());
    node("reload-profile-models").addEventListener("click", () => void this.refresh());
    this.model.addEventListener("change", () => this.loadProfile());
    node("profile-family").addEventListener("change", () => {
      const sdxl = node<HTMLSelectElement>("profile-family").value === "sdxl";
      node<HTMLInputElement>("profile-width").value = sdxl ? "1024" : "512";
      node<HTMLInputElement>("profile-height").value = sdxl ? "1024" : "512";
    });
    node<HTMLFormElement>("model-profile-form").addEventListener("submit", event => {
      event.preventDefault(); void this.save().catch(error => this.profileStatus(errorText(error)));
    });
    node("generate-profile").addEventListener("click", () => void this.generate());
    node("refresh-storage").addEventListener("click", () => void this.storage());
  }
  private enqueue(paths: string[]): void {
    this.queue.push(...paths.filter(path => /\.(safetensors|ckpt|pt|pth|bin)$/i.test(path)));
    if (!this.source) void this.next();
  }
  private async next(): Promise<void> {
    const path = this.queue.shift(); if (!path) return;
    this.source = path;
    try {
      this.preview = await this.api.inspectModelImport(path);
      node("model-import-name").textContent = `${this.preview.name} · ${size(this.preview.sizeBytes)}`;
      node<HTMLSelectElement>("model-import-type").value = this.preview.suggestedType;
      this.importTarget(); this.dialog.showModal();
    } catch (error) { this.notify(errorText(error)); this.source = null; void this.next(); }
  }
  private importTarget(): void {
    const type = node<HTMLSelectElement>("model-import-type").value;
    const target = this.preview?.destinations.find(item => item.modelType === type);
    node("model-import-target").textContent = target?.path ?? "";
    node("model-import-status").textContent = target?.duplicate ? "Файл с таким именем уже существует. Выберите другой тип или пропустите импорт." : "Исходный файл сохранится на месте.";
    node<HTMLButtonElement>("confirm-model-import").disabled = !target || target.duplicate;
  }
  private async import(): Promise<void> {
    if (!this.source || this.importing) return;
    this.importing = true;
    node<HTMLButtonElement>("confirm-model-import").disabled = true;
    node("model-import-status").textContent = "Копирование модели…";
    try {
      await this.api.importModelFile(this.source, node<HTMLSelectElement>("model-import-type").value);
      this.notify("Модель импортирована."); this.changed(); await this.refresh(); this.dialog.close();
    } catch (error) { node("model-import-status").textContent = errorText(error); }
    finally { this.importing = false; node<HTMLButtonElement>("confirm-model-import").disabled = false; }
  }
  async refresh(): Promise<void> {
    try {
      const [models, profiles] = await Promise.all([this.api.listInstalledModels(), this.api.getModelProfiles()]);
      this.profiles = profiles;
      const selected = this.model.value; this.model.replaceChildren();
      for (const model of models.filter(item => item.modelType === "Checkpoint")) {
        if ([...this.model.options].some(option => option.value === model.name)) continue;
        const option = new Option(model.name, model.name); this.model.add(option);
      }
      if ([...this.model.options].some(option => option.value === selected)) this.model.value = selected;
      this.loadProfile();
    } catch (error) { this.profileStatus(errorText(error)); }
  }
  private loadProfile(): void {
    const sdxl = /sdxl|illustrious|pony|xl/i.test(this.model.value);
    const profile = this.profiles.find(item => item.model === this.model.value);
    node<HTMLSelectElement>("profile-family").value = profile?.family ?? (sdxl ? "sdxl" : "sd15");
    node<HTMLInputElement>("profile-width").value = String(profile?.width ?? (sdxl ? 1024 : 512));
    node<HTMLInputElement>("profile-height").value = String(profile?.height ?? (sdxl ? 1024 : 512));
    node<HTMLInputElement>("profile-sampler").value = profile?.sampler ?? "Euler";
    node<HTMLInputElement>("profile-vae").value = profile?.vae ?? "Automatic";
    node<HTMLSelectElement>("profile-memory").value = profile?.memory ?? "auto";
    this.profileStatus(profile ? "Сохранённый профиль загружен." : "Выберите параметры и сохраните профиль.");
  }
  private profileStatus(text: string): void { node("profile-status").textContent = text; }
  private async save(): Promise<void> {
    if (!node<HTMLFormElement>("model-profile-form").reportValidity()) throw new Error("Проверьте поля профиля.");
    const profile: ModelProfile = {
      model: this.model.value, family: node<HTMLSelectElement>("profile-family").value === "sdxl" ? "sdxl" : "sd15",
      width: Number(node<HTMLInputElement>("profile-width").value), height: Number(node<HTMLInputElement>("profile-height").value),
      sampler: node<HTMLInputElement>("profile-sampler").value.trim(), vae: node<HTMLInputElement>("profile-vae").value.trim(),
      memory: node<HTMLSelectElement>("profile-memory").value as ModelProfile["memory"]
    };
    await this.api.saveModelProfile(profile);
    this.profiles = this.profiles.filter(item => item.model !== profile.model).concat(profile);
    this.profileStatus("Профиль сохранён. Изменение режима памяти A1111 требует перезапуска WebUI.");
  }
  private async generate(): Promise<void> {
    const button = node<HTMLButtonElement>("generate-profile"); button.disabled = true;
    try {
      await this.save(); this.profileStatus("Генерация идёт. Прогресс доступен на главной.");
      await this.api.generateWithProfile(this.model.value, node<HTMLTextAreaElement>("profile-prompt").value);
      this.profileStatus("Изображение сохранено в результатах WebUI.");
    } catch (error) { this.profileStatus(errorText(error)); }
    finally { button.disabled = false; }
  }
  private async storage(): Promise<void> {
    const button = node<HTMLButtonElement>("refresh-storage"); button.disabled = true;
    node("storage-status").textContent = "Подсчёт файлов…";
    try {
      const report = await this.api.getStorageReport();
      const total = report.modelsBytes + report.outputsBytes + report.packagesBytes;
      node("storage-status").textContent = `Всего ${size(total)}${report.skipped ? ` · недоступных папок: ${report.skipped}` : ""}. Размеры файлов без учёта сжатия диска.`;
      const map = node("storage-map"); map.replaceChildren();
      for (const [name, bytes] of [["Модели", report.modelsBytes], ["Результаты", report.outputsBytes], ["Пакеты", report.packagesBytes]] as const) {
        const row = document.createElement("div"); row.className = "storage-row";
        const label = document.createElement("span"); label.textContent = `${name} · ${size(bytes)}`;
        const track = document.createElement("div"); track.className = "generation-track";
        const fill = document.createElement("i"); fill.style.width = `${total ? bytes / total * 100 : 0}%`; track.append(fill); row.append(label, track); map.append(row);
      }
      const files = node("storage-files"); files.replaceChildren();
      for (const file of report.files) {
        const row = document.createElement("p"); row.className = "storage-file";
        row.textContent = `${file.name} · ${size(file.sizeBytes)}\n${file.path}`; files.append(row);
      }
    } catch (error) { node("storage-status").textContent = errorText(error); }
    finally { button.disabled = false; }
  }
}
