import { english } from "./locales/en.ts";

export type Language = "ru" | "en";
export const LANGUAGE_KEY = "flow.language";
let language: Language = "ru";
let confirmed = false;
try {
  const saved = localStorage.getItem(LANGUAGE_KEY);
  if (saved === "ru" || saved === "en") { language = saved; confirmed = true; }
} catch { /* The first-run chooser will explain persistence errors. */ }

export function getLanguage(): Language { return language; }
export function getLocale(): string { return language === "en" ? "en-US" : "ru-RU"; }

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const phrases = Object.keys(english).sort((a, b) => b.length - a.length);
const matcher = new RegExp(phrases.map(escapeRegex).join("|"), "gu");
const word = /[\p{L}\p{N}_]/u;

/** One pass, longest phrase first. Boundaries keep short unit labels out of words. */
export function translate(text: string, target: Language = language): string {
  if (target === "ru") return text;
  return text.replace(matcher, (match: string, offset: number) => {
    if ((word.test(match[0] ?? "") && word.test(text[offset - 1] ?? ""))
      || (word.test(match.at(-1) ?? "") && word.test(text[offset + match.length] ?? ""))) return match;
    return english[match] ?? match;
  });
}

interface Copy { source: string; rendered: string }
const textCopy = new WeakMap<Text, Copy>();
const attributeCopy = new WeakMap<Element, Map<string, Copy>>();
const attributes = ["title", "placeholder", "aria-label", "alt"] as const;
const excluded = '[translate="no"],script,style,textarea,pre:not(#terminal-log),code,#gallery-info-prompt,#gallery-info-negative,#gallery-info-model,#inspector-prompt,#inspector-negative,#inspector-model,#inspector-file-name,#inspector-file-path,#models-path,#model-import-target,#model-import-name,.file-select option,#profile-model option,.managed-model-details strong,.managed-model-details small,.download-card-title h3,.download-card-title small,#storage-files,.gallery-file-name';

function localizeText(node: Text): void {
  if (node.parentElement?.closest(excluded)) return;
  const value = node.data;
  const previous = textCopy.get(node);
  // A controller can replace its status at any time. Keep the fresh source,
  // rather than overwriting it with copy from a previous render.
  const source = previous?.rendered === value ? previous.source : value;
  const rendered = translate(source);
  textCopy.set(node, { source, rendered });
  if (value !== rendered) node.data = rendered;
}

function localizeElement(element: Element): void {
  if (element.closest(excluded)) return;
  let copies = attributeCopy.get(element);
  if (!copies) { copies = new Map(); attributeCopy.set(element, copies); }
  for (const name of attributes) {
    const value = element.getAttribute(name);
    if (value === null) continue;
    const previous = copies.get(name);
    const source = previous?.rendered === value ? previous.source : value;
    const rendered = translate(source);
    copies.set(name, { source, rendered });
    if (value !== rendered) element.setAttribute(name, rendered);
  }
}

/** Localization boundary for the existing imperative UI, including async cards.
 * Only text nodes and accessible copy change: DOM structure, input values,
 * event handlers and backend data are never replaced. Raw content opts out.
 */
function localizeTree(root: Node): void {
  if (root instanceof Text) { localizeText(root); return; }
  if (root instanceof Element) localizeElement(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node instanceof Text) localizeText(node);
    else if (node instanceof Element) localizeElement(node);
  }
}

export function setLanguage(next: Language): void {
  // Save first; a failed write must not silently complete first-run setup.
  localStorage.setItem(LANGUAGE_KEY, next);
  language = next;
  confirmed = true;
  document.documentElement.lang = next;
  localizeTree(document.body);
  const select = document.getElementById("language-select");
  if (select instanceof HTMLSelectElement) select.value = next;
  document.dispatchEvent(new CustomEvent<Language>("flow:language-changed", { detail: next }));
}

let initialized = false;
export function initializeLanguage(): void {
  if (initialized) return;
  initialized = true;
  document.documentElement.lang = language;
  localizeTree(document.body);
  // Process only changed branches. The last-rendered comparison prevents loops
  // when the observer sees its own text/attribute edits.
  new MutationObserver(records => {
    const roots = new Set<Node>();
    for (const record of records) {
      if (record.type === "childList") record.addedNodes.forEach(node => roots.add(node));
      else roots.add(record.target);
    }
    for (const root of roots) {
      if (root.isConnected) {
        if (root instanceof Element && records.some(record => record.type === "attributes" && record.target === root)) localizeElement(root);
        else localizeTree(root);
      }
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...attributes] });
  const select = document.getElementById("language-select");
  if (select instanceof HTMLSelectElement) {
    select.value = language;
    select.addEventListener("change", () => {
      if (select.value !== "ru" && select.value !== "en") return;
      try { setLanguage(select.value); }
      catch {
        select.value = language;
        window.alert(translate("Не удалось сохранить язык. Проверьте доступ к локальному хранилищу."));
      }
    });
  }
}

/** Must finish before Civitai onboarding can unlock the main interface. */
export function chooseFirstLanguage(): Promise<void> {
  if (confirmed) return Promise.resolve();
  const dialog = document.getElementById("language-dialog");
  if (!(dialog instanceof HTMLDialogElement)) return Promise.reject(new Error("Language dialog is missing"));
  return new Promise(resolve => {
    dialog.addEventListener("cancel", event => event.preventDefault());
    dialog.querySelectorAll<HTMLButtonElement>("[data-language]").forEach(button => {
      button.addEventListener("click", () => {
        const next = button.dataset.language;
        if (next !== "en" && next !== "ru") return;
        try {
          setLanguage(next);
          dialog.close();
          resolve();
        } catch {
          const error = dialog.querySelector<HTMLElement>("[role=alert]");
          if (error) error.textContent = "Не удалось сохранить язык / Could not save language. Please try again.";
        }
      });
    });
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>("[data-language]")?.focus();
  });
}
