import { DIAGNOSTIC_RULES, redactDiagnostics } from "./diagnostics.ts";
import type { DiagnosticIncident, DiagnosticMatch } from "./diagnostics.ts";
import type { GpuDiagnostics } from "./types.ts";

export function needsGpuCheck(incident: DiagnosticIncident): boolean {
  return incident.matches.some(match => match.rule.id === "gpu-unavailable" || match.rule.id === "cuda-driver");
}

/** Infer only what Windows reports. Eco mode is a possible explanation, never a detected fact. */
export function withGpuFindings(incident: DiagnosticIncident, gpu: GpuDiagnostics): DiagnosticIncident {
  if (!needsGpuCheck(incident) || gpu.error) return incident;
  // A stale PnP record must not hide a working NVIDIA device after a driver reinstall.
  if (gpu.devices.some(item => /nvidia/i.test(item.name) && item.present === true && item.problem === 0)) return incident;
  const device = gpu.devices.find(item => /nvidia/i.test(item.name)
    && (item.present === false || (item.problem !== null && item.problem !== 0)));
  if (!device) return incident;
  const base = DIAGNOSTIC_RULES.find(rule => rule.id === "gpu-unavailable");
  if (!base) return incident;
  const disconnected = device.present === false || device.problem === 45;
  const asus = /asus/i.test(gpu.manufacturer);
  const evidence = redactDiagnostics(`${device.name}: Present=${device.present ?? "unknown"}; code=${device.problem ?? "unknown"}; status=${device.status}`);
  const finding: DiagnosticMatch = {
    evidence,
    rule: {
      ...base,
      id: "gpu-device-state",
      title: disconnected ? "Windows не видит NVIDIA как подключённое устройство" : "Windows сообщает об ошибке NVIDIA",
      fact: evidence,
      cause: disconnected && asus
        ? "Windows сообщает, что видеокарта недоступна. На ASUS такое состояние бывает в Eco Mode. Текущий режим Armoury Crate автоматически не определён."
        : "Проверка Windows подтвердила проблему доступности устройства. Код устройства указан выше; это не сообщение о нехватке видеопамяти.",
      steps: disconnected && asus ? [
        "Подключите ноутбук к зарядке.",
        "В Armoury Crate откройте GPU Mode и выберите Standard вместо Eco. Если используется другая утилита ASUS, проверьте её режим дискретной видеокарты.",
        "Если утилита попросит — перезагрузите ноутбук. Затем проверьте, что NVIDIA появилась среди подключённых видеоадаптеров.",
        "Повторите установку в Flow в той же папке: установленный PyTorch и скачанные файлы не нужно удалять."
      ] : device.problem === 22 ? [
        "В Диспетчере устройств откройте Видеоадаптеры → NVIDIA и включите устройство.",
        "Повторите проверку устройств, затем продолжите установку в той же папке."
      ] : [
        "Откройте Диспетчер устройств → Видеоадаптеры → NVIDIA и проверьте описание кода ошибки.",
        "На ноутбуке проверьте питание и режим дискретной видеокарты в фирменной утилите.",
        "После восстановления устройства проверьте драйвер NVIDIA и повторите установку в той же папке."
      ],
      source: disconnected && asus ? { label: "ASUS · GPU Mode и Eco Mode", url: "https://www.asus.com/support/faq/1047107/" } : base.source,
      checkedOn: "2026-11-08",
      appliesTo: "Состояние устройств на момент нажатия кнопки; оно могло измениться после ошибки."
    }
  };
  return { ...incident, matches: [finding, ...incident.matches] };
}
