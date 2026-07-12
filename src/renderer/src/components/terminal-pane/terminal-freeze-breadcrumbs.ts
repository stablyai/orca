// Renderer half of the one-paste freeze report: a bounded ring of the
// delivery-affecting transitions (gate marks, visibility trust changes,
// watchdog heals, restore markers) so a field report carries the history
// that led to the frozen state, not just a point-in-time counter snapshot.
import {
  type PtyDeliveryBreadcrumb,
  createPtyDeliveryBreadcrumbRing
} from '../../../../shared/pty-delivery-diagnostics'
import { setTerminalWebglDiagnosticRecorder } from '../../../../shared/terminal-webgl-diagnostics'

const rendererDeliveryBreadcrumbs = createPtyDeliveryBreadcrumbRing()

export function recordTerminalFreezeBreadcrumb(
  kind: string,
  detail?: PtyDeliveryBreadcrumb['detail']
): void {
  rendererDeliveryBreadcrumbs.record(kind, detail)
}

// Why: lib-layer WebGL code (pane-webgl-renderer, the atlas registry) can't
// import this components-layer ring directly, so it records through a shared
// sink. Point that sink at the same ring here so context-loss and atlas-reset
// crumbs land in the one-paste report alongside delivery/visibility history.
setTerminalWebglDiagnosticRecorder((kind, detail) =>
  rendererDeliveryBreadcrumbs.record(kind, detail)
)

export function getTerminalFreezeBreadcrumbs(): PtyDeliveryBreadcrumb[] {
  return rendererDeliveryBreadcrumbs.snapshot()
}

export function resetTerminalFreezeBreadcrumbsForTesting(): void {
  rendererDeliveryBreadcrumbs.reset()
}
