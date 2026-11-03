import type { FlowAPI, InstalledModel } from "./types";

function required<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Элемент ${selector} не найден.`);
  return element;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "Неизвестная ошибка.";
}

function fileSize(bytes: number): string {
  const gib = 1024 ** 3;
  const mib = 1024 ** 2;
  const number = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
  return bytes >= gib ? `${number.format(bytes / gib)} ГБ` : `${number.format(bytes / mib)} МБ`;
}

/** Lists local model files and confirms deletion before asking the Rust backend to remove one. */
export class ModelManager {
  private readonly search: HTMLInputElement;
  private readonly count: HTMLElement;
  private readonly refreshButton: HTMLButtonElement;
  private readonly status: HTMLElement;
  private readonly list: HTMLElement;
  private readonly deleteMessage: HTMLElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly confirmButton: HTMLButtonElement;
  private models: InstalledModel[] = [];
  private pending: InstalledModel | null = null;
  private sequence = 0;

  constructor(
    private readonly api: FlowAPI,
    page: HTMLElement,
    private readonly dialog: HTMLDialogElement,
    private readonly notify: (message: string) => void,
    private readonly onDeleted: () => void
  ) {
    this.search = required<HTMLInputElement>(page, "#managed-models-search");
    this.count = required<HTMLElement>(page, "#managed-models-count");
    this.refreshButton = required<HTMLButtonElement>(page, "#refresh-managed-models");
    this.status = required<HTMLElement>(page, "#managed-models-status");
    this.list = required<HTMLElement>(page, "#managed-models-list");
    this.deleteMessage = required<HTMLElement>(dialog, "#managed-model-delete-message");
    this.cancelButton = required<HTMLButtonElement>(dialog, "#cancel-managed-model-delete");
    this.confirmButton = required<HTMLButtonElement>(dialog, "#confirm-managed-model-delete");
    this.search.addEventListener("input", () => this.render());
    this.refreshButton.addEventListener("click", () => void this.refresh());
    this.cancelButton.addEventListener("click", () => this.dialog.close());
    this.dialog.addEventListener("close", () => { this.pending = null; });
    this.confirmButton.addEventListener("click", () => void this.deletePending());
  }

  async refresh(): Promise<void> {
    const sequence = ++this.sequence;
    this.refreshButton.disabled = true;
    this.status.textContent = "Поиск моделей на диске…";
    try {
      const models = await this.api.listInstalledModels();
      if (sequence !== this.sequence) return;
      this.models = models;
      this.render();
    } catch (error) {
      if (sequence === this.sequence) this.status.textContent = `Не удалось прочитать модели: ${errorMessage(error)}`;
    } finally {
      if (sequence === this.sequence) this.refreshButton.disabled = false;
    }
  }

  private render(): void {
    const query = this.search.value.trim().toLocaleLowerCase("ru-RU");
    const visible = this.models.filter((model) => model.name.toLocaleLowerCase("ru-RU").includes(query));
    this.count.textContent = query ? `${visible.length} из ${this.models.length}` : `${this.models.length} моделей`;
    this.list.replaceChildren();
    this.status.textContent = visible.length ? "" : query ? "По запросу ничего не найдено." : "Моделей пока нет. Скачайте их в каталоге Civitai.";
    for (const model of visible) {
      const row = document.createElement("article");
      row.className = "managed-model-row";
      const icon = document.createElement("span");
      icon.className = "managed-model-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = "▧";
      const details = document.createElement("div");
      details.className = "managed-model-details";
      const name = document.createElement("strong");
      name.textContent = model.name;
      name.title = model.name;
      const meta = document.createElement("span");
      meta.textContent = `${model.modelType} · ${fileSize(model.sizeBytes)} · ${model.source}`;
      const path = document.createElement("small");
      path.textContent = model.path;
      path.title = model.path;
      details.append(name, meta, path);
      const remove = document.createElement("button");
      remove.className = "secondary-button managed-model-remove";
      remove.type = "button";
      remove.textContent = "Удалить";
      remove.setAttribute("aria-label", `Удалить модель ${model.name}`);
      remove.addEventListener("click", () => {
        this.pending = model;
        this.deleteMessage.textContent = `Удалить «${model.name}» (${fileSize(model.sizeBytes)}) без возможности восстановления?`;
        this.dialog.showModal();
      });
      row.append(icon, details, remove);
      this.list.append(row);
    }
  }

  private async deletePending(): Promise<void> {
    const model = this.pending;
    if (!model) return;
    this.confirmButton.disabled = true;
    this.cancelButton.disabled = true;
    try {
      await this.api.deleteInstalledModel(model.path);
      this.notify(`Модель «${model.name}» удалена.`);
      this.dialog.close();
      await this.refresh();
      this.onDeleted();
    } catch (error) {
      this.notify(`Не удалось удалить модель: ${errorMessage(error)}`);
    } finally {
      this.confirmButton.disabled = false;
      this.cancelButton.disabled = false;
    }
  }
}

