import type { ManagedPane } from './pane-manager-types'
import { recordTerminalWebglDiagnostic } from '../../../../shared/terminal-webgl-diagnostics'

/** The xterm options whose writes make the renderer clear, resize and full-refresh. */
export type PaneMetricOptions = {
  fontSize?: number
  fontFamily?: string
  fontWeight?: string | number
  fontWeightBold?: string | number
  lineHeight?: number
}

type PaneTerminal = ManagedPane['terminal']

// Why keyed on the terminal, not the pane: getPanes() hands out a fresh
// toPublicPane() wrapper per call, so a pane-keyed entry could never be found
// again. `terminal` is carried by reference and dies with the pane.
const deferredMetricOptions = new WeakMap<PaneTerminal, PaneMetricOptions>()

/**
 * Why deferred: writing one of these makes xterm clear the renderer, re-resize
 * to the current grid and full-refresh. On a pane with no usable box that
 * repaint is wasted — it lands in the DOM-renderer fallback while WebGL is
 * suspended — and the cols/rows re-fit that has to follow the write cannot run.
 * So the values park here and land once the pane can actually be fitted.
 */
export function applyOrDeferPaneMetricOptions(
  pane: ManagedPane,
  options: PaneMetricOptions,
  measurable: boolean
): 'applied' | 'deferred' {
  if (!measurable) {
    // Latest wins: a newer settings change while hidden supersedes the pending one.
    deferredMetricOptions.set(pane.terminal, options)
    return 'deferred'
  }
  deferredMetricOptions.delete(pane.terminal)
  writePaneMetricOptions(pane, options)
  return 'applied'
}

/** Applies a pending deferral. Callers must ensure the pane is measurable. */
export function flushDeferredPaneMetricOptions(pane: ManagedPane): boolean {
  const pending = deferredMetricOptions.get(pane.terminal)
  if (!pending) {
    return false
  }
  deferredMetricOptions.delete(pane.terminal)
  writePaneMetricOptions(pane, pending)
  recordTerminalWebglDiagnostic('metric-options-deferred-flush', { paneId: pane.id })
  return true
}

export function hasDeferredPaneMetricOptions(pane: ManagedPane): boolean {
  return deferredMetricOptions.has(pane.terminal)
}

/**
 * True when every value is already live and nothing is parked, so the caller can
 * skip the apply. Why it matters: any settings write re-runs the appearance pass
 * over every mounted pane, and arming a no-op deferral would make the next
 * reveal refit for nothing.
 */
export function paneMetricOptionsAlreadySettled(
  pane: ManagedPane,
  options: PaneMetricOptions
): boolean {
  if (deferredMetricOptions.has(pane.terminal)) {
    return false
  }
  const target = pane.terminal.options
  return (
    (options.fontSize === undefined || target.fontSize === options.fontSize) &&
    (options.fontFamily === undefined || target.fontFamily === options.fontFamily) &&
    (options.fontWeight === undefined || target.fontWeight === options.fontWeight) &&
    (options.fontWeightBold === undefined || target.fontWeightBold === options.fontWeightBold) &&
    (options.lineHeight === undefined || target.lineHeight === options.lineHeight)
  )
}

/**
 * Folds a directly-applied metric write into any pending deferral so a later
 * flush cannot clobber it with the parked value. No-op when nothing is parked.
 */
export function overridePendingPaneMetricOptions(
  pane: ManagedPane,
  options: PaneMetricOptions
): void {
  const pending = deferredMetricOptions.get(pane.terminal)
  if (!pending) {
    return
  }
  deferredMetricOptions.set(pane.terminal, { ...pending, ...options })
}

function writePaneMetricOptions(pane: ManagedPane, options: PaneMetricOptions): void {
  const target = pane.terminal.options
  if (options.fontSize !== undefined) {
    target.fontSize = options.fontSize
  }
  if (options.fontFamily !== undefined) {
    target.fontFamily = options.fontFamily
  }
  if (options.fontWeight !== undefined) {
    target.fontWeight = options.fontWeight as typeof target.fontWeight
  }
  if (options.fontWeightBold !== undefined) {
    target.fontWeightBold = options.fontWeightBold as typeof target.fontWeightBold
  }
  if (options.lineHeight !== undefined) {
    target.lineHeight = options.lineHeight
  }
}
