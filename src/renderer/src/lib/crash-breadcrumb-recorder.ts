import type { CrashReportBreadcrumbData } from '../../../shared/crash-reporting'

// Why a leaf module: terminal modules (replay-guard, output scheduler, parser
// guards) record breadcrumbs, and e2e specs import those modules' constants —
// Playwright loads spec imports at collection time under a transform that
// cannot handle crash-diagnostics.ts (top-level `import.meta.hot` plus the
// webview-registry import chain). Keep this file free of value imports and
// import.meta so it stays loadable from any context.

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
  } catch {
    // Best-effort crash evidence only.
  }
}
