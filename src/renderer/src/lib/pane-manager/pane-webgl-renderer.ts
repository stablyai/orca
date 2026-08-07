import { WebglAddon } from '@xterm/addon-webgl'
import type { ManagedPaneInternal } from './pane-manager-types'
import { recordTerminalWebglDiagnostic } from '../../../../shared/terminal-webgl-diagnostics'
import { getLivePaneCensus } from './pane-manager-registry'
import { forceRepaintThroughRenderPause } from './terminal-render-pause-release'
import {
  getTerminalWebglAutoDecision,
  resetTerminalWebglAutoDecision
} from './terminal-webgl-auto-policy'
import { safeFit, safeFitAndThen } from './pane-fit'
import { setPaneFitWebglAttachHook } from './pane-fit-webgl-attach-signal'

export const ENABLE_WEBGL_RENDERER = true
let suggestedRendererType: 'dom' | undefined
// Attach-failure latching is per-pane (pane.webglAttachFailedSinceRecovery):
// while Chromium refuses WebGL context creation, every attach attempt burns a
// canvas + failed getContext and logs a full-stack warning — and title changes
// retrigger attach constantly in "on" mode. Each pane latches its own failure
// and retries at the next recovery boundary (rendering resume or GPU-setting
// change). A module-global latch here previously let ONE pane's failure strand
// every other pane on the DOM renderer until the next boundary.

type ReleasableWebglContext = {
  getExtension(name: 'WEBGL_lose_context'): WEBGL_lose_context | null
}

type XtermWebglAddonInternals = {
  _renderer?: {
    _gl?: ReleasableWebglContext
    _canvas?: HTMLCanvasElement
  }
}

export function resetTerminalWebglSuggestion(): void {
  // Why: toggling GPU settings should let "auto" retry WebGL after an earlier
  // attach failure suggested DOM rendering for this app session. Per-pane
  // failure latches are cleared by the callers that iterate panes.
  suggestedRendererType = undefined
  resetTerminalWebglAutoDecision()
}

export function clearTerminalWebglAttachBackoff(pane: ManagedPaneInternal): void {
  pane.webglAttachFailedSinceRecovery = false
}

export function shouldUseTerminalWebgl(pane: ManagedPaneInternal): boolean {
  if (pane.terminalGpuAcceleration === 'on') {
    return true
  }
  if (pane.terminalGpuAcceleration !== 'auto' || suggestedRendererType === 'dom') {
    return false
  }
  return getTerminalWebglAutoDecision().allowWebgl
}

function refreshTerminalAfterWebglAttach(pane: ManagedPaneInternal): void {
  try {
    // Why: a newly attached WebGL canvas starts empty; repaint immediately so
    // resume/reparent/settings toggles do not look frozen until new output.
    pane.terminal.refresh(0, pane.terminal.rows - 1)
  } catch {
    /* ignore - pane may have been disposed in the meantime */
  }
}

export function cancelPendingWebglRefresh(pane: ManagedPaneInternal): void {
  if (pane.pendingWebglRefreshRafId == null) {
    return
  }
  if (typeof globalThis.cancelAnimationFrame === 'function') {
    globalThis.cancelAnimationFrame(pane.pendingWebglRefreshRafId)
  }
  pane.pendingWebglRefreshRafId = null
}

export function disposeWebgl(
  pane: ManagedPaneInternal,
  options?: { refreshDimensions?: boolean }
): void {
  cancelPendingWebglRefresh(pane)
  if (!pane.webglAddon) {
    return
  }
  releaseXtermWebglContext(pane.webglAddon)
  try {
    pane.webglAddon.dispose()
  } catch {
    /* ignore */
  }
  pane.webglAddon = null
  if (options?.refreshDimensions) {
    // Why: DOM and WebGL renderer cell metrics differ after teardown. Without
    // a refit, Linux DOM scrollbars can desync and trigger visible reflow jitter.
    pane.pendingWebglRefreshRafId = requestAnimationFrame(() => {
      pane.pendingWebglRefreshRafId = null
      try {
        // Why: context loss can coincide with snapshot parsing; refresh only
        // after the replay-aware fit has authoritative renderer dimensions.
        safeFitAndThen(pane, 'webgl-fallback-refresh', () => {
          pane.terminal.refresh(0, pane.terminal.rows - 1)
        })
      } catch {
        /* ignore — pane may have been disposed in the meantime */
      }
    })
  }
}

function releaseXtermWebglContext(webglAddon: ManagedPaneInternal['webglAddon']): void {
  try {
    // Why: xterm removes the canvas on dispose, but Windows/ANGLE can keep the
    // driver context alive long enough for rapid terminal activation to hit
    // Chromium's active WebGL context budget (#6874).
    const renderer = (webglAddon as unknown as XtermWebglAddonInternals | null)?._renderer
    renderer?._gl?.getExtension('WEBGL_lose_context')?.loseContext()
    if (renderer?._canvas) {
      renderer._canvas.width = 0
      renderer._canvas.height = 0
    }
  } catch {
    /* ignore - WebGL teardown must not block fallback to the DOM renderer */
  }
}

export function markComplexScriptOutput(pane: ManagedPaneInternal): void {
  pane.hasComplexScriptOutput = true
}

export function resetWebglTextureAtlas(pane: ManagedPaneInternal): void {
  if (pane.webglDisabledAfterContextLoss) {
    return
  }
  try {
    // Why: rapid TUI redraws can corrupt xterm's WebGL glyph atlas without a
    // context-loss event. Clearing the atlas preserves GPU rendering and forces
    // a fresh paint when the pane becomes visible/focused again.
    pane.webglAddon?.clearTextureAtlas()
    // Why: on reveal xterm's IntersectionObserver can still report the pane as
    // not intersecting, so a plain refresh() is swallowed by RenderService's
    // paused-render gate and the cleared model never repaints (stale bottom rows
    // until a drag-select forces a redraw). Force the paused render through
    // first; only fall back to refresh() when the terminal was not gated.
    if (!forceRepaintThroughRenderPause(pane.terminal)) {
      // Why: refresh even without a WebGL addon so recovery never silently
      // no-ops — a DOM-rendered pane can hold stale pixels after reveal too.
      pane.terminal.refresh(0, pane.terminal.rows - 1)
    }
  } catch {
    /* ignore — pane may have been disposed in the meantime */
  }
}

function refitAfterFitAnchoredWebglAttach(pane: ManagedPaneInternal): void {
  // Why: the fit that triggered this attach measured DOM cell metrics, but WebGL
  // floors the device cell width — keeping that grid leaves an unpainted right
  // gutter and a PTY narrower than the pane. Refit on the next frame (mirroring
  // the dispose-side refreshDimensions) so xterm has re-measured against the new
  // renderer, and so the running fit is never re-entered.
  if (typeof globalThis.requestAnimationFrame !== 'function') {
    return
  }
  pane.pendingWebglRefreshRafId = globalThis.requestAnimationFrame(() => {
    pane.pendingWebglRefreshRafId = null
    try {
      safeFit(pane)
    } catch {
      /* ignore — pane may have been disposed in the meantime */
    }
  })
}

export function attachWebglAfterFitIfMissing(pane: ManagedPaneInternal): void {
  // Why: a successful fit is the event-anchored moment a WebGL-eligible pane
  // that is stuck on the DOM renderer can heal — a late mount that missed the
  // coalesced reveal repaint, or a fallback whose cause has passed. A user
  // resize then repairs the bold/wider DOM-rendered pane instead of leaving it.
  // The per-pane failure latch stays honored: genuinely failed attaches retry
  // only at recovery boundaries.
  if (
    !pane.webglAddon &&
    pane.gpuRenderingEnabled &&
    !pane.webglAttachmentDeferred &&
    !pane.webglDisabledAfterContextLoss &&
    !pane.webglAttachFailedSinceRecovery &&
    shouldUseTerminalWebgl(pane)
  ) {
    attachWebgl(pane)
    if (pane.webglAddon) {
      recordTerminalWebglDiagnostic('webgl-fit-attach', { paneId: pane.id })
      refitAfterFitAnchoredWebglAttach(pane)
    }
  }
}

setPaneFitWebglAttachHook(attachWebglAfterFitIfMissing)

export function attachWebgl(pane: ManagedPaneInternal): void {
  if (
    !ENABLE_WEBGL_RENDERER ||
    !pane.gpuRenderingEnabled ||
    !shouldUseTerminalWebgl(pane) ||
    pane.webglAttachmentDeferred ||
    pane.webglDisabledAfterContextLoss ||
    pane.webglAttachFailedSinceRecovery
  ) {
    // Why: nulling the reference here used to leak a still-loaded addon that
    // kept painting stale frames while every recovery path (atlas reset,
    // reattach, diagnostics) treated the pane as DOM-rendered. Dispose so the
    // pane genuinely falls back to the DOM renderer.
    disposeWebgl(pane, { refreshDimensions: true })
    return
  }
  // Single-addon invariant: never stack a second addon on a live one.
  disposeWebgl(pane)
  let webglAddon: WebglAddon | null = null
  try {
    webglAddon = new WebglAddon()
    const addon = webglAddon
    addon.onContextLoss(() => {
      console.warn(
        '[terminal] WebGL context lost for pane',
        pane.id,
        '— falling back to DOM renderer'
      )
      // Why: a lost context is the decisive signal for a post-wake garble
      // report — it means the glyph atlas was wiped (needs a full reset), not
      // just a missed repaint. Silent breadcrumb; the console.warn stays.
      // Census rides along: a GPU-process death loses every pane's context at
      // once, and the crash-report ring coalesces repeats, so the count has to
      // be in the payload rather than in the number of crumbs.
      const census = getLivePaneCensus()
      recordTerminalWebglDiagnostic('webgl-context-loss', {
        paneId: pane.id,
        livePanes: census.panes,
        livePaneManagers: census.managers
      })
      // Why: Chromium starts reclaiming terminal contexts under pressure.
      // Recreating WebGL for this pane can loop context loss and leave xterm
      // visually blank, so keep the pane on the DOM renderer until the next
      // rendering resume (worktree foreground / window wake) retries it.
      pane.webglDisabledAfterContextLoss = true
      disposeWebgl(pane, { refreshDimensions: true })
    })
    pane.terminal.loadAddon(addon)
    pane.webglAddon = addon
    refreshTerminalAfterWebglAttach(pane)
  } catch (err) {
    if (pane.terminalGpuAcceleration === 'auto') {
      // Why: "auto" tries the faster renderer first, but one failed attach is
      // enough signal to keep new auto panes on DOM until the setting changes.
      suggestedRendererType = 'dom'
    }
    pane.webglAttachFailedSinceRecovery = true
    // WebGL not available — default DOM renderer is fine, but log it for debugging
    console.warn('[terminal] WebGL unavailable for pane', pane.id, '— using DOM renderer:', err)
    try {
      webglAddon?.dispose()
    } catch {
      /* ignore — a half-constructed addon may throw on dispose */
    }
    pane.webglAddon = null
  }
}
