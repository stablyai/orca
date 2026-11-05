// Production DevTools freeze report combines renderer/main state and breadcrumbs over invoke, which can survive dead push delivery.
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
    // Per-pane WebGL state distinguishes stale wake surfaces from context-loss fallback.
    paneRendering: ReturnType<typeof getAllPaneRenderingDiagnostics>
    breadcrumbs: ReturnType<typeof getTerminalFreezeBreadcrumbs>
  }
  main: unknown
}

export async function buildTerminalFreezeReport(): Promise<TerminalFreezeReport> {
  const hasDocument = typeof document !== 'undefined'
  // Capture failed invoke as diagnostic data; never lose the whole report.
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
