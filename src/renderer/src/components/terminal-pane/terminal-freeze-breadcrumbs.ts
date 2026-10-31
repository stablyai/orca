// Keep bounded delivery/visibility/restore history so freeze reports explain the transitions preceding the snapshot.
import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'
import {
  type PtyDeliveryBreadcrumb,
  createPtyDeliveryBreadcrumbRing
} from '../../../../shared/pty-delivery-diagnostics'
import {
  TERMINAL_WEBGL_DIAGNOSTIC_BREADCRUMB,
  recordTerminalWebglDiagnostic,
  setTerminalWebglDiagnosticRecorder
} from '../../../../shared/terminal-webgl-diagnostics'
import { maybeStartTerminalRenderDesyncSentinel } from './terminal-render-desync-trigger'

const rendererDeliveryBreadcrumbs = createPtyDeliveryBreadcrumbRing()
const ATLAS_FONT_PROBE_MISMATCH = 'atlas-font-probe-mismatch'
const ATLAS_CRASH_MIRROR_INTERVAL_MS = 30_000
let lastAtlasCrashMirrorAt = Number.NEGATIVE_INFINITY
let suppressedAtlasCrashMirrors = 0

export function recordTerminalFreezeBreadcrumb(
  kind: string,
  detail?: PtyDeliveryBreadcrumb['detail']
): void {
  rendererDeliveryBreadcrumbs.record(kind, detail)
}

// Lib WebGL code reports through a shared sink to avoid a components-layer import; mirror into crash breadcrumbs because renderer death loses the DevTools ring.
setTerminalWebglDiagnosticRecorder((kind, detail) => {
  rendererDeliveryBreadcrumbs.record(kind, detail)
  if (kind === ATLAS_FONT_PROBE_MISMATCH) {
    const now = Date.now()
    if (now - lastAtlasCrashMirrorAt < ATLAS_CRASH_MIRROR_INTERVAL_MS) {
      suppressedAtlasCrashMirrors++
      return
    }
    lastAtlasCrashMirrorAt = now
  }
  // Write kind last so details cannot override the coalescing discriminator.
  recordRendererCrashBreadcrumb(TERMINAL_WEBGL_DIAGNOSTIC_BREADCRUMB, {
    ...detail,
    ...(kind === ATLAS_FONT_PROBE_MISMATCH && suppressedAtlasCrashMirrors > 0
      ? { rendererSuppressedSinceLast: suppressedAtlasCrashMirrors }
      : {}),
    kind
  })
  if (kind === ATLAS_FONT_PROBE_MISMATCH) {
    suppressedAtlasCrashMirrors = 0
  }
})

// Bootstrap the opt-in production sentinel independently of pane mounting; disabled unless localStorage enables it.
maybeStartTerminalRenderDesyncSentinel()

// The patched WebGL atlas reports failed ctx.font assignments through this global; upstream coalescing bounds rasterization storms.
type AtlasFontProbeMismatch = { desired?: string; actual?: string }
;(globalThis as { __orcaAtlasFontProbe?: (mismatch: AtlasFontProbeMismatch) => void })[
  '__orcaAtlasFontProbe'
] = (mismatch) => {
  recordTerminalWebglDiagnostic(ATLAS_FONT_PROBE_MISMATCH, {
    desired: mismatch?.desired ?? null,
    actual: mismatch?.actual ?? null
  })
}

export function getTerminalFreezeBreadcrumbs(): PtyDeliveryBreadcrumb[] {
  return rendererDeliveryBreadcrumbs.snapshot()
}

export function resetTerminalFreezeBreadcrumbsForTesting(): void {
  rendererDeliveryBreadcrumbs.reset()
  lastAtlasCrashMirrorAt = Number.NEGATIVE_INFINITY
  suppressedAtlasCrashMirrors = 0
}
