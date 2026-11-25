import type { FlowAPI } from "./types";
import { translate } from "./i18n";

export function initializeModelFolders(api: FlowAPI, changed: () => Promise<void>, notify: (message: string) => void): void {
  const list = document.getElementById("model-library-folders");
  const add = document.getElementById("add-model-library-folder") as HTMLButtonElement | null;
  if (!list || !add) return;
  const report = (error: unknown): void => notify(error instanceof Error ? error.message : String(error));
  const refresh = async (): Promise<void> => {
    const folders = await api.getModelFolders();
    list.replaceChildren();
    for (const folder of folders) {
      const row = document.createElement("div");
      row.className = "library-folder";
      const path = document.createElement("code");
      path.className = "library-path";
      path.setAttribute("translate", "no");
      path.textContent = folder;
      const remove = document.createElement("button");
      remove.className = "secondary-button";
      remove.textContent = translate("Отключить папку");
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        try { await api.removeModelFolder(folder); await refresh(); await changed(); }
        catch (error) { report(error); remove.disabled = false; }
      });
      row.append(path, remove);
      list.append(row);
    }
  };
  add.addEventListener("click", async () => {
    add.disabled = true;
    try {
      const directory = await api.browseInstallationDirectory("");
      if (directory) { await api.addModelFolder(directory); await refresh(); await changed(); }
    } catch (error) { report(error); }
    finally { add.disabled = false; }
  });
  void refresh().catch(report);
}
