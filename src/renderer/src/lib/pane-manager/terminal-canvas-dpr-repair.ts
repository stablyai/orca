import type { ManagedPane } from './pane-manager-types'
import { recordTerminalWebglDiagnostic } from '../../../../shared/terminal-webgl-diagnostics'

/**
 * Why: when devicePixelRatio changes while a pane is hidden (window moved
 * between retina/non-retina displays, then the worktree revealed), xterm's
 * WebGL renderer re-measures cell dimensions but its canvas keeps the old
 * backing-store size — the addon's own device-pixel observer misses changes
 * that land while the element has no box. The browser then composites the
 * stale-scale bitmap into the css box: half/double-size or smeared text until
 * a real resize. Proven live: backing 2160 px for a 1080 css box at dpr 1.
 * The repair is xterm's own resize path, which recomputes device dimensions
 * at the current dpr and resizes the canvas backing store.
 */
type XtermRendererInternals = {
  _canvas?: HTMLCanvasElement
  _gl?: { canvas?: HTMLCanvasElement }
  dimensions?: {
    device?: { canvas?: { width?: number; height?: number } }
  }
  handleDevicePixelRatioChange?: () => void
  handleResize?: (cols: number, rows: number) => void
}

export function repairPaneWebglCanvasDprMismatch(pane: ManagedPane): boolean {
  const renderer = (
    pane.terminal as unknown as {
      _core?: { _renderService?: { _renderer?: { value?: XtermRendererInternals } } }
    }
  )._core?._renderService?._renderer?.value
  const canvas = renderer?._canvas ?? renderer?._gl?.canvas
  if (!renderer || !canvas?.isConnected) {
    return false
  }
  const view = canvas.ownerDocument?.defaultView
  const expected = renderer.dimensions?.device?.canvas
  const expectedWidth = expected?.width ?? 0
  const expectedHeight = expected?.height ?? 0
  if (!view || expectedWidth <= 0 || expectedHeight <= 0) {
    return false
  }
  const staleBackingWidth = canvas.width
  const staleBackingHeight = canvas.height
  // xterm rounds its CSS canvas size before ResizeObserver converts it back to
  // device pixels; allow that round trip without forcing layout on every fit.
  const roundingTolerance = Math.max(1, Math.ceil(view.devicePixelRatio / 2))
  if (
    Math.abs(staleBackingWidth - expectedWidth) <= roundingTolerance &&
    Math.abs(staleBackingHeight - expectedHeight) <= roundingTolerance
  ) {
    return false
  }
  try {
    // Order matters: refresh the renderer's cached dpr/dimensions first, then
    // the resize path recreates the backing store and layer sizes from them.
    renderer.handleDevicePixelRatioChange?.()
    renderer.handleResize?.(pane.terminal.cols, pane.terminal.rows)
    pane.terminal.refresh(0, pane.terminal.rows - 1)
  } catch {
    // Pane may be mid-teardown; the next reveal/fit retries the check.
    return false
  }
  recordTerminalWebglDiagnostic('webgl-canvas-dpr-repair', {
    paneId: pane.id,
    staleBackingWidth,
    expectedBackingWidth: expectedWidth,
    devicePixelRatio: view.devicePixelRatio
  })
  return true
}
