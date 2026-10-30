import type { WebglAddon } from '@xterm/addon-webgl'
import type { ManagedPaneInternal } from './pane-manager-types'
import { recordTerminalWebglDiagnostic } from '../../../../shared/terminal-webgl-diagnostics'
import { getLivePaneCensus } from './pane-manager-registry'
import {
  getTerminalWebglAutoDecision,
  resetTerminalWebglAutoDecision
} from './terminal-webgl-auto-policy'
import { safeFit, safeFitAndThen } from './pane-fit'
import { setPaneFitWebglAttachHook } from './pane-fit-webgl-attach-signal'
import {
  repairPaneWebglCanvasDprMismatch,
  restoreReleasedPaneWebglCanvas
} from './terminal-canvas-dpr-repair'
import { recordPaneWebglContextLoss } from './pane-webgl-context-loss-policy'
import { presentPaneViewport } from './pane-viewport-present'
import {
  releaseWebglCanvasBackingWhileHidden,
  stopReleasingWebglCanvasBacking
} from './terminal-webgl-hidden-canvas-release'

export { presentPaneViewport } from './pane-viewport-present'
import {
  getTerminalWebglAddonConstructor,
  primeTerminalWebglAddon,
  rearmTerminalWebglAddonLoad,
  setTerminalWebglAddonLoadHandlers
} from './terminal-webgl-addon-loader'

export { primeTerminalWebglAddon } from './terminal-webgl-addon-loader'

export const ENABLE_WEBGL_RENDERER = true
let suggestedRendererType: 'dom' | undefined
// Latch attach failures per pane to avoid repeated canvas/getContext allocation and stack warnings on title changes. Retry on rendering resume/GPU settings recovery; a global latch would strand unrelated panes on DOM.

type ReleasableWebglContext = {
  getExtension(name: 'WEBGL_lose_context'): WEBGL_lose_context | null
  isContextLost?: () => boolean
}

type XtermWebglAddonInternals = {
  _renderer?: {
    _gl?: ReleasableWebglContext
    _canvas?: HTMLCanvasElement
  }
}

const panesAwaitingWebglAddon = new Set<ManagedPaneInternal>()

setTerminalWebglAddonLoadHandlers({
  onLoaded: () => {
    // Panes opened before lazy resolution retain DOM-measured grids; pair late attach with refit. attachWebgl removes its current Set entry safely during iteration.
    for (const pane of panesAwaitingWebglAddon) {
      attachWebglAndRefit(pane, 'webgl-deferred-attach')
    }
  },
  onFailed: () => {
    // Latch loader failures like construction failures; retry at recovery boundaries, never every frame.
    for (const pane of panesAwaitingWebglAddon) {
      pane.webglAttachFailedSinceRecovery = true
    }
    panesAwaitingWebglAddon.clear()
  }
})

export function resetTerminalWebglSuggestion(): void {
  // GPU settings changes let auto retry after failure; pane-iterating callers clear per-pane latches.
  suggestedRendererType = undefined
  // Rearm failed addon loading at the same recovery boundary or panes stay on DOM.
  rearmTerminalWebglAddonLoad()
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
    // New WebGL canvases are empty; repaint immediately so resume/reparent/settings do not look frozen until output.
    pane.terminal.refresh(0, pane.terminal.rows - 1)
  } catch {}
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

export function isPaneWebglContextLost(pane: ManagedPaneInternal): boolean {
  try {
    const renderer = (pane.webglAddon as unknown as XtermWebglAddonInternals | null)?._renderer
    return renderer?._gl?.isContextLost?.() === true
  } catch {
    return true
  }
}

export function disposeWebgl(
  pane: ManagedPaneInternal,
  options?: { refreshDimensions?: boolean }
): void {
  cancelPendingWebglRefresh(pane)
  panesAwaitingWebglAddon.delete(pane)
  if (!pane.webglAddon) {
    return
  }
  releaseXtermWebglContext(pane.webglAddon)
  try {
    pane.webglAddon.dispose()
  } catch {}
  pane.webglAddon = null
  if (options?.refreshDimensions) {
    // Refit after teardown because DOM/WebGL cell metrics differ; otherwise Linux scrollbars desync and reflow jitters.
    pane.pendingWebglRefreshRafId = requestAnimationFrame(() => {
      pane.pendingWebglRefreshRafId = null
      try {
        // Context loss can overlap snapshot parsing; refresh after replay-aware fit makes dimensions authoritative.
        safeFitAndThen(pane, 'webgl-fallback-refresh', () => {
          pane.terminal.refresh(0, pane.terminal.rows - 1)
        })
      } catch {}
    })
  }
}

function getXtermWebglCanvas(webglAddon: WebglAddon): HTMLCanvasElement | undefined {
  if (!('_renderer' in webglAddon)) {
    return undefined
  }
  const renderer = webglAddon._renderer
  if (typeof renderer !== 'object' || renderer === null || !('_canvas' in renderer)) {
    return undefined
  }
  const canvas = renderer._canvas
  return typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement
    ? canvas
    : undefined
}

function releaseXtermWebglContext(webglAddon: ManagedPaneInternal['webglAddon']): void {
  try {
    // Windows/ANGLE may retain driver contexts after canvas removal; explicitly lose them to avoid Chromium’s active-context budget on rapid activation (#6874).
    const renderer = (webglAddon as unknown as XtermWebglAddonInternals | null)?._renderer
    if (renderer?._canvas) {
      stopReleasingWebglCanvasBacking(renderer._canvas)
    }
    renderer?._gl?.getExtension('WEBGL_lose_context')?.loseContext()
    if (renderer?._canvas) {
      renderer._canvas.width = 0
      renderer._canvas.height = 0
    }
  } catch {}
}

export function markComplexScriptOutput(pane: ManagedPaneInternal): void {
  pane.hasComplexScriptOutput = true
}

export function clearWebglTextureAtlas(pane: ManagedPaneInternal): void {
  if (pane.webglDisabledAfterContextLoss) {
    return
  }
  try {
    // TUI redraws can corrupt glyph atlases without context loss; clear and repaint on reveal/focus while retaining GPU rendering.
    pane.webglAddon?.clearTextureAtlas()
  } catch {}
}

export function resetWebglTextureAtlas(pane: ManagedPaneInternal): void {
  clearWebglTextureAtlas(pane)
  presentPaneViewport(pane)
}

function refitAfterLateWebglAttach(pane: ManagedPaneInternal): void {
  // DOM-measured grids differ from WebGL’s floored device-cell widths, leaving narrow PTYs/gutters. Refit next frame after renderer remeasurement, never reenter the running fit.
  if (typeof globalThis.requestAnimationFrame !== 'function') {
    return
  }
  pane.pendingWebglRefreshRafId = globalThis.requestAnimationFrame(() => {
    pane.pendingWebglRefreshRafId = null
    try {
      safeFit(pane)
    } catch {}
  })
}

/** Pair every late attach with refit to replace DOM-measured dimensions. */
function attachWebglAndRefit(pane: ManagedPaneInternal, diagnosticKind: string): void {
  attachWebgl(pane)
  if (pane.webglAddon) {
    recordTerminalWebglDiagnostic(diagnosticKind, { paneId: pane.id })
    refitAfterLateWebglAttach(pane)
  }
}

export function attachWebglAfterFitIfMissing(pane: ManagedPaneInternal): void {
  // Successful fits let measurable DOM-stuck panes heal after missed reveal or transient fallback; honor actual attach-failure latches until recovery boundaries.
  if (
    !pane.webglAddon &&
    pane.gpuRenderingEnabled &&
    !pane.webglAttachmentDeferred &&
    !pane.webglDisabledAfterContextLoss &&
    !pane.webglAttachFailedSinceRecovery &&
    shouldUseTerminalWebgl(pane)
  ) {
    attachWebglAndRefit(pane, 'webgl-fit-attach')
  }
}

setPaneFitWebglAttachHook((pane) => {
  attachWebglAfterFitIfMissing(pane)
  // A fit proves a live box, the first safe chance to repair canvas DPR after a hidden-time display change.
  repairPaneWebglCanvasDprMismatch(pane)
})

export function attachWebgl(pane: ManagedPaneInternal): void {
  if (
    !ENABLE_WEBGL_RENDERER ||
    !pane.gpuRenderingEnabled ||
    !shouldUseTerminalWebgl(pane) ||
    pane.webglAttachmentDeferred ||
    pane.webglDisabledAfterContextLoss ||
    pane.webglAttachFailedSinceRecovery
  ) {
    // Dispose before nulling; leaked addons paint stale frames while atlas recovery/reattach/diagnostics incorrectly treat them as DOM.
    disposeWebgl(pane, { refreshDimensions: true })
    return
  }
  disposeWebgl(pane)
  const WebglAddonConstructor = getTerminalWebglAddonConstructor()
  if (!WebglAddonConstructor) {
    // Opening before lazy resolution parks here; the load continuation attaches, with the fit hook as backstop.
    panesAwaitingWebglAddon.add(pane)
    void primeTerminalWebglAddon()
    return
  }
  let webglAddon: WebglAddon | null = null
  try {
    webglAddon = new WebglAddonConstructor()
    const addon = webglAddon
    addon.onContextLoss(() => {
      console.warn(
        '[terminal] WebGL context lost for pane',
        pane.id,
        '— falling back to DOM renderer'
      )
      // Context loss proves an atlas wipe rather than missed repaint. Record it with census counts because GPU death affects all panes and crash crumbs coalesce.
      const census = getLivePaneCensus()
      const lossesInWindow = recordPaneWebglContextLoss(pane)
      recordTerminalWebglDiagnostic('webgl-context-loss', {
        paneId: pane.id,
        lossesInWindow,
        livePanes: census.panes,
        livePaneManagers: census.managers
      })
      // Use DOM until resume/settled reveal; the shared loss window bounds unstable retries.
      pane.webglDisabledAfterContextLoss = true
      disposeWebgl(pane, { refreshDimensions: true })
    })
    pane.terminal.loadAddon(addon)
    pane.webglAddon = addon
    const canvas = getXtermWebglCanvas(addon)
    if (canvas) {
      // Why: panes of a hidden worktree surface keep their backing so switching worktrees never pays a reallocation.
      releaseWebglCanvasBackingWhileHidden(
        canvas,
        () => pane.container.closest('[data-worktree-surface-hidden]') === null,
        (devicePixelSize) => restoreReleasedPaneWebglCanvas(pane, devicePixelSize)
      )
    }
    refreshTerminalAfterWebglAttach(pane)
  } catch (err) {
    if (pane.terminalGpuAcceleration === 'auto') {
      // One failed auto attach keeps new auto panes on DOM until GPU settings change.
      suggestedRendererType = 'dom'
    }
    pane.webglAttachFailedSinceRecovery = true
    console.warn('[terminal] WebGL unavailable for pane', pane.id, '— using DOM renderer:', err)
    try {
      webglAddon?.dispose()
    } catch {}
    pane.webglAddon = null
  }
}
