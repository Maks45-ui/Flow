import "./snow.css";
const ENABLED_KEY = "flow.snow.enabled";
const INTENSITY_KEY = "flow.snow.intensity";
const SIZE_KEY = "flow.snow.size";
function savedNumber(key: string, fallback: number, min: number, max: number, step: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null || raw.trim() === "") return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value >= min && value <= max && (value - min) % step === 0 ? value : fallback;
  } catch { return fallback; }
}
function save(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* Keep session controls usable without storage. */ }
}
function createFlake(): HTMLElement {
  const flake = document.createElement("span");
  flake.className = "flow-snow-flake";
  flake.style.left = String(Math.random() * 100) + "%";
  flake.style.setProperty("--snow-factor", String(0.65 + Math.random() * 0.7));
  flake.style.setProperty("--snow-duration", String(16 + Math.random() * 14) + "s");
  flake.style.setProperty("--snow-delay", String(-Math.random() * 30) + "s");
  flake.style.setProperty("--snow-drift", String(Math.random() * 70 - 35) + "px");
  return flake;
}
/** A bounded CSS-only pool; existing animations survive changes of size/density. */
export function initializeSnow(): void {
  const toggle = document.querySelector<HTMLInputElement>("#snow-enabled");
  const intensity = document.querySelector<HTMLInputElement>("#snow-intensity");
  const size = document.querySelector<HTMLInputElement>("#snow-size");
  const intensityValue = document.querySelector<HTMLOutputElement>("#snow-intensity-value");
  const sizeValue = document.querySelector<HTMLOutputElement>("#snow-size-value");
  if (!toggle || !intensity || !size || !intensityValue || !sizeValue || document.getElementById("flow-snow")) return;
  const overlay = document.createElement("div");
  overlay.id = "flow-snow";
  overlay.className = "flow-snow";
  overlay.setAttribute("aria-hidden", "true");
  document.body.append(overlay);
  let enabled = true;
  let count = savedNumber(INTENSITY_KEY, 24, 12, 60, 12);
  let pixels = savedNumber(SIZE_KEY, 3, 2, 6, 1);
  try { enabled = localStorage.getItem(ENABLED_KEY) !== "false"; } catch { /* Use default. */ }
  const apply = (): void => {
    toggle.checked = enabled;
    intensity.value = String(count);
    size.value = String(pixels);
    intensityValue.value = String(count);
    sizeValue.value = String(pixels) + " px";
    intensity.disabled = size.disabled = !enabled;
    overlay.hidden = !enabled;
    overlay.classList.toggle("flow-snow-paused", document.hidden);
    overlay.style.setProperty("--snow-size", String(pixels) + "px");
    while (overlay.childElementCount < count) overlay.append(createFlake());
    while (overlay.childElementCount > count) overlay.lastElementChild?.remove();
  };
  toggle.addEventListener("change", () => {
    enabled = toggle.checked;
    save(ENABLED_KEY, String(enabled));
    apply();
  });
  intensity.addEventListener("input", () => {
    count = Math.max(12, Math.min(60, Math.round(Number(intensity.value) / 12) * 12));
    save(INTENSITY_KEY, String(count));
    apply();
  });
  size.addEventListener("input", () => {
    pixels = Math.max(2, Math.min(6, Math.round(Number(size.value))));
    save(SIZE_KEY, String(pixels));
    apply();
  });
  document.addEventListener("visibilitychange", () => overlay.classList.toggle("flow-snow-paused", document.hidden));
  apply();
}
