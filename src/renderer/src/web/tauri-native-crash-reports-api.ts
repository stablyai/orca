import type {
  CrashReportBreadcrumbData,
  CrashReportCopyDiagnosticsArgs,
  CrashReportRecord,
  CrashReportSubmitArgs,
  CrashReportSubmitResult,
  ReactErrorBoundaryReportArgs,
  ReactErrorBoundaryReportResult,
  UncapturedCrashReportContext
} from '../../../shared/crash-reporting/crash-reporting'
import type { CrashReportsApi } from '../../../preload/api/diagnostics/crash-report-api'
import {
  formatCrashReportText,
  formatUncapturedCrashReportText
} from '../../../shared/crash-reporting/crash-reporting'
import {
  assertClipboardTextWriteWithinLimit,
  isClipboardTextWriteTooLargeError
} from '../../../shared/clipboard/clipboard-text'
import { formatCrashReportCopyText } from '../../../main/crash-reporting/reports/crash-report-copy-text'
import { invokeNative, invokePlugin, isTauriNativeHost } from './tauri-native-host'
import { getBrowserPlatform } from './preload-api/web-storage'

type CrashReportLookup = { reportId?: string }

type TauriNativePlatformInfo = {
  platform?: unknown
  osRelease?: unknown
  arch?: unknown
}

function asNonEmptyString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value ? value : fallback
}

function asNodePlatform(value: unknown): NodeJS.Platform {
  if (value === 'win32' || value === 'darwin' || value === 'linux') {
    return value
  }
  return getBrowserPlatform()
}

async function readUncapturedContext(): Promise<UncapturedCrashReportContext> {
  const [version, platformInfo] = await Promise.all([
    invokeNative<string>('poc_updater_get_version').catch(() => 'unknown'),
    invokeNative<TauriNativePlatformInfo>('poc_platform_info').catch(() => null)
  ])
  return {
    createdAt: new Date().toISOString(),
    appVersion: asNonEmptyString(version, 'unknown'),
    platform: asNodePlatform(platformInfo?.platform),
    osRelease: asNonEmptyString(platformInfo?.osRelease, ''),
    arch: asNonEmptyString(platformInfo?.arch, ''),
    electronVersion: 'tauri',
    chromeVersion: 'webview'
  }
}

const COPY_TOO_LARGE_ERROR = 'Crash diagnostics are too large to copy safely.'

export function createTauriNativeCrashReportsApi(): CrashReportsApi | null {
  if (!isTauriNativeHost()) {
    return null
  }
  return {
    getLatestPending: () =>
      invokeNative<CrashReportRecord | null>('poc_crash_reports_get_latest_pending'),
    getLatestReport: () => invokeNative<CrashReportRecord | null>('poc_crash_reports_get_latest'),
    dismiss: (args) =>
      invokeNative<CrashReportRecord | null>('poc_crash_reports_dismiss', { args }),
    recordRendererError: (args: ReactErrorBoundaryReportArgs) =>
      invokeNative<ReactErrorBoundaryReportResult>('poc_crash_reports_record_renderer_error', {
        args
      }),
    recordBreadcrumb: (args: { name: string; data?: CrashReportBreadcrumbData }): void => {
      void invokeNative('poc_crash_reports_record_breadcrumb', { args }).catch(() => {})
    },
    submit: (args: CrashReportSubmitArgs): Promise<CrashReportSubmitResult> =>
      invokeNative<CrashReportSubmitResult>('poc_crash_reports_submit', { args }),
    copyLatestDiagnostics: async (args?: CrashReportCopyDiagnosticsArgs) => {
      const lookup: CrashReportLookup | undefined = args?.reportId
        ? { reportId: args.reportId }
        : undefined
      const report = await invokeNative<CrashReportRecord | null>(
        'poc_crash_reports_get_requested',
        { args: lookup }
      )
      // Mirror Electron: copy falls back to uncaptured text when nothing was captured.
      const baseText = report
        ? formatCrashReportText(report, args?.notes)
        : formatUncapturedCrashReportText(await readUncapturedContext(), args?.notes)
      let copyText: string
      try {
        copyText = assertClipboardTextWriteWithinLimit(
          formatCrashReportCopyText(baseText, args?.submissionFailure)
        )
      } catch (error) {
        if (isClipboardTextWriteTooLargeError(error)) {
          return { ok: false as const, error: COPY_TOO_LARGE_ERROR }
        }
        throw error
      }
      try {
        await invokePlugin('clipboard-manager', 'write_text', {
          text: copyText,
          label: null
        })
        return { ok: true as const }
      } catch (error) {
        if (isClipboardTextWriteTooLargeError(error)) {
          return { ok: false as const, error: COPY_TOO_LARGE_ERROR }
        }
        return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
      }
    },
    readHeapStatistics: () => null
  }
}
