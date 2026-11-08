import { invoke } from "@tauri-apps/api/core";
import { withErrorHelp } from "./error-help";
import type { GpuDiagnostics, ModelImportPreview, ModelProfile, StorageReport } from "./types";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { AppState, CheckReport, DownloadedFile, FlowAPI, FlowUpdate, GalleryImage, GalleryImageDetails, GenerationProgress, InstalledModel, ModelFile, ModelSummary, PackageInfo, Page, StarterModel, TaskEvent, WebUISettings, WebUIStatus } from "./types";

// The UI only knows this typed contract. System access stays in Rust.
const nativeFlowApi: FlowAPI = {
  getGpuDiagnostics: () => invoke<GpuDiagnostics>("get_gpu_diagnostics"),
  installComfyUI: (installationDir) => invoke<void>("install_comfyui", { installationDir }),
  onGenerationComplete: async (callback) => listen("flow:generation-complete", () => callback()),
  openDiscordServer: () => invoke<void>("open_discord_server"),
  inspectModelImport: (path: string) => invoke<ModelImportPreview>("inspect_model_import", { path }),
  importModelFile: (path: string, modelType: string) => invoke<string>("import_model_file", { path, modelType }),
  browseModelFiles: async () => {
    const files = await open({ multiple: true, directory: false, filters: [{ name: "Модели", extensions: ["safetensors", "ckpt", "pt", "pth", "bin"] }] });
    return Array.isArray(files) ? files : typeof files === "string" ? [files] : [];
  },
  getModelProfiles: () => invoke<ModelProfile[]>("get_model_profiles"),
  saveModelProfile: (profile: ModelProfile) => invoke<void>("save_model_profile", { profile }),
  generateWithProfile: (model: string, prompt: string) => invoke<void>("generate_with_profile", { model, prompt }),
  getStorageReport: () => invoke<StorageReport>("get_storage_report"),
  getState: () => invoke<AppState>("get_state"),
  openDiagnosticSource: (url: string) => invoke<void>("open_diagnostic_source", { url }),
  getWebUIStatus: () => invoke<WebUIStatus>("get_webui_status"),
  getGenerationProgress: () => invoke<GenerationProgress>("get_generation_progress"),
  installForgeNeo: (installationDir: string) => invoke<void>("install_forge_neo_web_ui", { installationDir }),
  cancelInstall: () => invoke<void>("cancel_install"),
  launchWebUI: (packageId?: PackageInfo["id"]) => invoke<void>("launch_web_ui", { packageId }),
  registerForgeNeo: (directory: string) => invoke<void>("register_forge_neo", { directory }),
  selectPackage: (packageId: PackageInfo["id"]) => invoke<void>("select_package", { packageId }),
  stopWebUI: () => invoke<void>("stop_web_ui"),
  openWebUI: () => invoke<void>("open_web_ui"),
  getWebUIArguments: () => invoke<string[]>("get_webui_arguments"),
  saveWebUIArguments: (argumentsList: string[]) => invoke<string[]>("save_webui_arguments", { arguments: argumentsList }),
  getWebUISettings: () => invoke<WebUISettings>("get_webui_settings"),
  saveWebUISettings: (settings: WebUISettings) => invoke<WebUISettings>("save_webui_settings", { settings }),
  checkXformers: () => invoke<string>("check_xformers"),
  installXformers: () => invoke<void>("install_xformers"),
  listGalleryImages: () => invoke<GalleryImage[]>("list_gallery_images"),
  getGalleryImageDetails: (path: string) => invoke<GalleryImageDetails>("get_gallery_image_details", { path }),
  copyGalleryImage: (path: string) => invoke<void>("copy_gallery_image", { path }),
  deleteGalleryImages: (paths: string[]) => invoke<number>("delete_gallery_images", { paths }),
  searchModels: (query: string, sort: "popular" | "newest" | "rated", modelType: string) => invoke<ModelSummary[]>("search_models", { query, sort, modelType }),
  getStarterModel: (key: string) => invoke<StarterModel>("get_starter_model", { key }),
  downloadModel: (file: ModelFile, type: string, taskId: string, resume: boolean) => invoke<void>("download_model", { file, modelType: type, taskId, resume }),
  pauseDownload: () => invoke<void>("pause_download"),
  cancelDownload: () => invoke<void>("cancel_download"),
  listDownloads: () => invoke<DownloadedFile[]>("list_downloads"),
  deleteDownload: (modelType: string, fileName: string) => invoke<void>("delete_download", { modelType, fileName }),
  listInstalledModels: () => invoke<InstalledModel[]>("list_installed_models"),
  deleteInstalledModel: (path: string) => invoke<void>("delete_installed_model", { path }),
  getPreview: (url: string) => invoke<string>("get_preview", { url }),
  saveCivitaiToken: (token: string) => invoke<void>("save_civitai_token", { token }),
  getOnboardingComplete: () => invoke<boolean>("get_onboarding_complete"),
  getOnboardingStage: () => invoke<number>("get_onboarding_stage"),
  saveOnboardingToken: (token: string | null) => invoke<void>("save_onboarding_token", { token }),
  finishOnboarding: () => invoke<void>("finish_onboarding"),
  openCivitaiSite: () => invoke<void>("open_civitai_site"),
  saveInstallationDirectory: (directory: string) => invoke<void>("set_installation_dir", { directory }),
  saveModelsLibraryDirectory: (directory: string) => invoke<void>("set_models_library_dir", { directory }),
  getPreflight: (packageId: PackageInfo["id"]) => invoke<CheckReport>("get_preflight", { packageId }),
  checkPackage: (packageId: PackageInfo["id"]) => invoke<CheckReport>("check_package", { packageId }),
  repairPackage: (packageId: PackageInfo["id"]) => invoke<void>("repair_package", { packageId }),
  updatePackage: (packageId: PackageInfo["id"]) => invoke<void>("update_package", { packageId }),
  rollbackPackage: (packageId: PackageInfo["id"]) => invoke<void>("rollback_package", { packageId }),
  checkFlowUpdate: () => invoke<FlowUpdate>("check_flow_update"),
  openFlowReleases: () => invoke<void>("open_flow_releases"),
  linkPackageModels: (packageId: PackageInfo["id"]) => invoke<string>("link_package_models", { packageId }),
  setPage: (page: Page) => invoke<void>("set_page", { page }),
  onTask: async (callback: (event: TaskEvent) => void) => listen<TaskEvent>("flow:task", (event) => callback(event.payload)),
  browseInstallationDirectory: async (currentPath: string) => {
    // Tauri v2 returns a path or null for a single directory selection.
    const selected = await open({ directory: true, multiple: false, defaultPath: currentPath || undefined });
    return typeof selected === "string" ? selected : null;
  }
};


export const flowApi: FlowAPI = withErrorHelp(nativeFlowApi);
