import type { DiagnosticsApi } from '../../../preload/api/diagnostics/telemetry-api'
import { invokeNative, isTauriNativeHost } from './tauri-native-host'

export function createTauriNativeDiagnosticsApi(): DiagnosticsApi | null {
  if (!isTauriNativeHost()) {
    return null
  }
  return {
    getStatus: () => invokeNative('poc_diagnostics_get_status'),
    collectBundle: (lookbackMinutes) =>
      invokeNative('poc_diagnostics_collect_bundle', { lookbackMinutes }),
    openBundlePreview: (bundleSubmissionId) =>
      invokeNative('poc_diagnostics_open_bundle_preview', { bundleSubmissionId }),
    discardBundlePreview: (bundleSubmissionId) =>
      invokeNative('poc_diagnostics_discard_bundle_preview', { bundleSubmissionId }),
    uploadBundle: (bundleSubmissionId) =>
      invokeNative('poc_diagnostics_upload_bundle', { bundleSubmissionId }),
    deleteBundle: (ticketId) => invokeNative('poc_diagnostics_delete_bundle', { ticketId })
  }
}
