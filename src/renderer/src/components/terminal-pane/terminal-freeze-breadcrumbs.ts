// Renderer half of the one-paste freeze report: a bounded ring of the
// delivery-affecting transitions (gate marks, visibility trust changes,
// watchdog heals, restore markers) so a field report carries the history
// that led to the frozen state, not just a point-in-time counter snapshot.
import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'
import {
  type PtyDeliveryBreadcrumb,
  createPtyDeliveryBreadcrumbRing
} from '../../../../shared/pty-delivery-diagnostics'
import {
  TERMINAL_WEBGL_DIAGNOSTIC_BREADCRUMB,
  setTerminalWebglDiagnosticRecorder
} from '../../../../shared/terminal-webgl-diagnostics'
import { maybeStartTerminalRenderDesyncSentinel } from './terminal-render-desync-sentinel'

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
//
// Also mirror into the crash-report ring: this ring is DevTools-only (readable
// solely via window.n()), so a renderer that dies takes the WebGL history with
// it. Windows crash F0BKR84AHEH had three GPU-process deaths in the 65s before
// its renderer OOM and zero WebGL evidence in the bundle — absence of
// instrumentation, not absence of the event.
setTerminalWebglDiagnosticRecorder((kind, detail) => {
  rendererDeliveryBreadcrumbs.record(kind, detail)
  // `kind` last: it is the coalescing discriminator, so a detail field of the
  // same name must not be able to shadow it.
  recordRendererCrashBreadcrumb(TERMINAL_WEBGL_DIAGNOSTIC_BREADCRUMB, { ...detail, kind })
})

// Why: the sentinel is a field-diagnostic that must be armable on production
// builds; starting it from this diagnostics bootstrap keeps arming independent
// of any specific pane mounting first. No-op unless its localStorage flag is set.
maybeStartTerminalRenderDesyncSentinel()

export function getTerminalFreezeBreadcrumbs(): PtyDeliveryBreadcrumb[] {
  return rendererDeliveryBreadcrumbs.snapshot()
}

export function resetTerminalFreezeBreadcrumbsForTesting(): void {
  rendererDeliveryBreadcrumbs.reset()
}
