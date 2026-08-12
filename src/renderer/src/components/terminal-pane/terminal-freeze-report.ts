// One-paste freeze report: `await window.__orcaTerminalFreezeReport()` in the
// DevTools console of a frozen window returns renderer state, main state (with
// per-pty delivery table), and both processes' breadcrumb history in a single
// JSON blob. Assembled over invoke IPC — the direction proven alive in every
// field wedge observed — and installed in PROD builds, because the whole point
// is that an affected user never has to gather logs piecemeal again.
import { getTerminalFreezeBreadcrumbs } from './terminal-freeze-breadcrumbs'
import { getTerminalDeliveryWatchdogDiagnostics } from './terminal-delivery-watchdog'
import { isDocumentVisibilityProvenStale } from './stale-document-visibility'
import { getAllPaneRenderingDiagnostics } from '@/lib/pane-manager/pane-manager-registry'

export type TerminalFreezeReport = {
  capturedAt: string
  renderer: {
    documentVisibilityState: string | null
    documentHasFocus: boolean | null
    documentVisibilityProvenStale: boolean
    ptyDataListenerCount: number | null
    watchdog: ReturnType<typeof getTerminalDeliveryWatchdogDiagnostics>
    // Why: per-pane WebGL state distinguishes a stale post-wake surface from a
    // context-loss fallback — the missing signal for the garble-after-sleep class.
    paneRendering: ReturnType<typeof getAllPaneRenderingDiagnostics>
    breadcrumbs: ReturnType<typeof getTerminalFreezeBreadcrumbs>
  }
  main: unknown
}

export async function buildTerminalFreezeReport(): Promise<TerminalFreezeReport> {
  const hasDocument = typeof document !== 'undefined'
  // The main section must never sink the whole report — a dead invoke channel
  // is itself a diagnostic worth capturing.
  const main = await window.api?.pty
    ?.getRendererDeliveryDebugSnapshot?.()
    .catch((error: unknown) => ({ snapshotError: String(error) }))
  return {
    capturedAt: new Date().toISOString(),
    renderer: {
      documentVisibilityState: hasDocument ? document.visibilityState : null,
      documentHasFocus: hasDocument ? document.hasFocus() : null,
      documentVisibilityProvenStale: isDocumentVisibilityProvenStale(),
      ptyDataListenerCount: window.api?.pty?.getPtyDataListenerCount?.() ?? null,
      watchdog: getTerminalDeliveryWatchdogDiagnostics(),
      paneRendering: getAllPaneRenderingDiagnostics(),
      breadcrumbs: getTerminalFreezeBreadcrumbs()
    },
    main: main ?? null
  }
}

type TerminalFreezeReportWindow = Window & {
  __orcaTerminalFreezeReport?: () => Promise<TerminalFreezeReport>
}

export function installTerminalFreezeReport(): void {
  if (typeof window === 'undefined') {
    return
  }
  ;(window as TerminalFreezeReportWindow).__orcaTerminalFreezeReport = buildTerminalFreezeReport
}
