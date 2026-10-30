import type { ManagedPane } from './pane-manager-types'
import { recordTerminalWebglDiagnostic } from '../../../../shared/terminal-webgl-diagnostics'
import { forceFullViewportPresent } from './terminal-render-pause-release'
import { isWebglCanvasBackingReleased } from './terminal-webgl-hidden-canvas-release'

// Hidden-time DPR changes can evade WebGL’s device-pixel observer, leaving stale-scale canvas backing (e.g. 2160px for 1080 CSS pixels at DPR 1). Use xterm’s resize path to recompute device dimensions/backing at current DPR.
type XtermRendererInternals = {
  _canvas?: HTMLCanvasElement
  _devicePixelRatio?: number
  _gl?: { canvas?: HTMLCanvasElement }
  dimensions?: {
    device?: { canvas?: { width?: number; height?: number } }
  }
  handleDevicePixelRatioChange?: () => void
  handleResize?: (cols: number, rows: number) => void
}

// 'released': the hidden backing was collapsed and its reveal restore resizes at the current DPR, so callers treat it as current.
export type PaneWebglCanvasDprRepairState = 'current' | 'deferred' | 'released' | 'repaired'

function getXtermRenderer(pane: ManagedPane): XtermRendererInternals | undefined {
  return (
    pane.terminal as unknown as {
      _core?: { _renderService?: { _renderer?: { value?: XtermRendererInternals } } }
    }
  )._core?._renderService?._renderer?.value
}

export function repairPaneWebglCanvasDpr(pane: ManagedPane): PaneWebglCanvasDprRepairState {
  const renderer = getXtermRenderer(pane)
  const canvas = renderer?._canvas ?? renderer?._gl?.canvas
  if (!renderer || !canvas) {
    return 'current'
  }
  if (isWebglCanvasBackingReleased(canvas)) {
    return 'released'
  }
  if (!canvas.isConnected) {
    return 'deferred'
  }
  const view = canvas.ownerDocument?.defaultView
  const expected = renderer.dimensions?.device?.canvas
  const expectedWidth = expected?.width ?? 0
  const expectedHeight = expected?.height ?? 0
  if (!view || expectedWidth <= 0 || expectedHeight <= 0) {
    return 'deferred'
  }
  const staleBackingWidth = canvas.width
  const staleBackingHeight = canvas.height
  const cachedDevicePixelRatio = renderer._devicePixelRatio
  const devicePixelRatioChanged =
    typeof cachedDevicePixelRatio === 'number' && cachedDevicePixelRatio !== view.devicePixelRatio
  // Allow rounding from xterm’s CSS size back to device pixels without forcing layout every fit.
  const roundingTolerance = Math.max(1, Math.ceil(view.devicePixelRatio / 2))
  if (
    !devicePixelRatioChanged &&
    Math.abs(staleBackingWidth - expectedWidth) <= roundingTolerance &&
    Math.abs(staleBackingHeight - expectedHeight) <= roundingTolerance
  ) {
    return 'current'
  }
  try {
    // Refresh cached DPR/dimensions before resize rebuilds backing and layer sizes.
    renderer.handleDevicePixelRatioChange?.()
    renderer.handleResize?.(pane.terminal.cols, pane.terminal.rows)
    pane.terminal.refresh(0, pane.terminal.rows - 1)
  } catch {
    // Pane may be mid-teardown; the next reveal/fit retries the check.
    return 'deferred'
  }
  recordTerminalWebglDiagnostic('webgl-canvas-dpr-repair', {
    paneId: pane.id,
    staleBackingWidth,
    expectedBackingWidth: expectedWidth,
    ...(cachedDevicePixelRatio === undefined ? {} : { cachedDevicePixelRatio }),
    devicePixelRatio: view.devicePixelRatio
  })
  return 'repaired'
}

export function repairPaneWebglCanvasDprMismatch(pane: ManagedPane): boolean {
  return repairPaneWebglCanvasDpr(pane) === 'repaired'
}

/** Reveal of a released canvas: reallocate and draw past xterm's still-paused renderer so the first painted frame has content. Reuses the cached layout and atlas unless the DPR changed while hidden. */
export function restoreReleasedPaneWebglCanvas(
  pane: ManagedPane,
  devicePixelSize: { width: number; height: number } | null
): void {
  const renderer = getXtermRenderer(pane)
  const canvas = renderer?._canvas ?? renderer?._gl?.canvas
  const view = canvas?.ownerDocument?.defaultView
  if (!renderer || !canvas || !view) {
    return
  }
  try {
    if (
      renderer._devicePixelRatio !== view.devicePixelRatio &&
      renderer.handleDevicePixelRatioChange
    ) {
      // A monitor move while hidden: recompute dimensions and rebuild at the new DPR.
      renderer.handleDevicePixelRatioChange()
    } else if (canvas.width === 0 && canvas.height === 0) {
      // Match xterm's device-pixel observer exactly so it finds nothing to resize (a second
      // reallocation and redraw); engines without that box fall back to xterm's own canvas size.
      const size = devicePixelSize ?? renderer.dimensions?.device?.canvas
      canvas.width = size?.width ?? 0
      canvas.height = size?.height ?? 0
    }
    // Unlike an ordinary reveal, the released canvas holds no last coherent frame to keep, so a
    // TUI mid DEC 2026 frame gets this one non-atomic paint instead of up to 1s of blank canvas.
    if (!forceFullViewportPresent(pane.terminal)) {
      pane.terminal.refresh(0, pane.terminal.rows - 1)
    }
  } catch {
    // Pane may be mid-teardown; xterm's own observers still repaint a frame later.
  }
}
