import "./snow.css";

const STORAGE_KEY = "flow.snow.enabled";

/** CSS-only particles: no animation loop, layout reads or mouse handlers. */
export function initializeSnow(): void {
  const toggle = document.querySelector<HTMLInputElement>("#snow-enabled");
  if (!toggle || document.getElementById("flow-snow")) return;

  const overlay = document.createElement("div");
  overlay.id = "flow-snow";
  overlay.className = "flow-snow";
  overlay.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 24; index++) {
    const flake = document.createElement("span");
    flake.className = "flow-snow-flake";
    flake.style.left = `${Math.random() * 100}%`;
    flake.style.setProperty("--snow-size", `${2 + Math.random() * 2}px`);
    flake.style.setProperty("--snow-duration", `${16 + Math.random() * 14}s`);
    flake.style.setProperty("--snow-delay", `${-Math.random() * 30}s`);
    flake.style.setProperty("--snow-drift", `${Math.random() * 70 - 35}px`);
    overlay.append(flake);
  }
  document.body.append(overlay);

  let enabled = true;
  try { enabled = localStorage.getItem(STORAGE_KEY) !== "false"; }
  catch { /* The setting still works for this session without storage. */ }
  const apply = (): void => {
    toggle.checked = enabled;
    overlay.hidden = !enabled;
    overlay.classList.toggle("flow-snow-paused", document.hidden);
  };
  toggle.addEventListener("change", () => {
    enabled = toggle.checked;
    try { localStorage.setItem(STORAGE_KEY, String(enabled)); }
    catch { /* Keep the user's current choice for this session. */ }
    apply();
  });
  document.addEventListener("visibilitychange", apply);
  apply();
}
