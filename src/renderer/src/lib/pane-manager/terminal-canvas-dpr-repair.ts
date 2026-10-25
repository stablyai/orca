import type { ManagedPane } from './pane-manager-types'
import { recordTerminalWebglDiagnostic } from '../../../../shared/terminal-webgl-diagnostics'

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

export type PaneWebglCanvasDprRepairState = 'current' | 'deferred' | 'repaired'

export function repairPaneWebglCanvasDpr(pane: ManagedPane): PaneWebglCanvasDprRepairState {
  const renderer = (
    pane.terminal as unknown as {
      _core?: { _renderService?: { _renderer?: { value?: XtermRendererInternals } } }
    }
  )._core?._renderService?._renderer?.value
  const canvas = renderer?._canvas ?? renderer?._gl?.canvas
  if (!renderer || !canvas) {
    return 'current'
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
