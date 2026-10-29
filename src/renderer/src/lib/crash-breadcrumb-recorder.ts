import type { CrashReportBreadcrumbData } from '../../../shared/crash-reporting'

// Keep free of value imports/import.meta: Playwright collection reaches terminal constants but cannot load crash-diagnostics and its webview chain.

/** Best-effort breadcrumb recording; must never create or mask failures. */
export function recordRendererCrashBreadcrumb(
  name: string,
  data?: CrashReportBreadcrumbData
): void {
  if (typeof window === 'undefined') {
    return
  }

  try {
    const api = (window as Window & { api?: Window['api'] }).api
    api?.crashReports.recordBreadcrumb({ name, ...(data ? { data } : {}) })
  } catch {}
}
