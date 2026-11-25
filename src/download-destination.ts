import type { DownloadDestination, ModelFile } from "./types";
import { translate } from "./i18n";
import "./model-library.css";

function size(bytes: number): string { return `${(bytes / 1024 ** 3).toFixed(2)} GB`; }

/** File paths are always plain text, never translated or interpreted as HTML. */
export function confirmDestination(file: ModelFile, target: DownloadDestination): Promise<boolean> {
  const dialog = document.createElement("dialog");
  dialog.className = "modal glass-surface download-destination";
  dialog.setAttribute("aria-labelledby", "download-destination-title");
  const title = document.createElement("h2");
  title.id = "download-destination-title";
  title.textContent = translate("Куда скачать модель?");
  const name = document.createElement("p");
  name.textContent = file.name;
  name.setAttribute("translate", "no");
  const path = document.createElement("code");
  path.className = "library-path";
  path.textContent = target.directory;
  path.setAttribute("translate", "no");
  const metrics = document.createElement("p");
  const enough = target.freeBytes === null || target.freeBytes >= target.requiredBytes + 64 * 1024 ** 2;
  metrics.textContent = `${translate("Нужно скачать")}: ${target.requiredBytes ? size(target.requiredBytes) : translate("Размер неизвестен")} · ${translate("Свободно")}: ${target.freeBytes === null ? translate("Не удалось определить") : size(target.freeBytes)}`;
  const note = document.createElement("p");
  note.textContent = translate(enough ? "Папку сохранения можно изменить в настройках общей библиотеки. Место проверяется повторно перед загрузкой." : "Недостаточно места. Выберите другой диск в настройках общей библиотеки.");
  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const cancel = document.createElement("button");
  cancel.className = "secondary-button";
  cancel.textContent = translate("Отменить");
  const confirm = document.createElement("button");
  confirm.className = "primary-button";
  confirm.textContent = translate("Скачать");
  confirm.disabled = !enough;
  actions.append(cancel, confirm);
  dialog.append(title, name, path, metrics, note, actions);
  document.body.append(dialog);
  return new Promise(resolve => {
    let approved = false;
    cancel.addEventListener("click", () => dialog.close());
    confirm.addEventListener("click", () => { approved = true; dialog.close(); });
    dialog.addEventListener("close", () => { dialog.remove(); resolve(approved); }, { once: true });
    dialog.showModal();
    cancel.focus();
  });
}
