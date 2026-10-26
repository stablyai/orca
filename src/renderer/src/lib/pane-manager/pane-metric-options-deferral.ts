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

// Key by terminal: fresh getPanes wrappers cannot retrieve pane-identity entries; the terminal survives every view.
const deferredMetricOptions = new WeakMap<PaneTerminal, PaneMetricOptions>()

/** Metric writes clear/resize/refresh xterm. Defer while unmeasurable: repaint would be wasted on DOM fallback and its required refit cannot run until a usable box returns. */
export function applyOrDeferPaneMetricOptions(
  pane: ManagedPane,
  options: PaneMetricOptions,
  measurable: boolean,
  reason = 'appearance'
): 'applied' | 'deferred' {
  if (!measurable) {
    deferredMetricOptions.set(pane.terminal, options)
    return 'deferred'
  }
  deferredMetricOptions.delete(pane.terminal)
  writePaneMetricOptions(pane, options, reason)
  return 'applied'
}

/** Applies a pending deferral. Callers must ensure the pane is measurable. */
export function flushDeferredPaneMetricOptions(pane: ManagedPane): boolean {
  const pending = deferredMetricOptions.get(pane.terminal)
  if (!pending) {
    return false
  }
  deferredMetricOptions.delete(pane.terminal)
  writePaneMetricOptions(pane, pending, 'deferred-flush')
  recordTerminalWebglDiagnostic('metric-options-deferred-flush', { paneId: pane.id })
  return true
}

export function hasDeferredPaneMetricOptions(pane: ManagedPane): boolean {
  return deferredMetricOptions.has(pane.terminal)
}

/** Skip only when values are live and nothing is parked; every settings change visits all panes, so no-op deferrals would trigger needless reveal fits. */
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

/** Fold direct metric writes into parked values so a later flush cannot overwrite them; no-op without deferral. */
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

function writePaneMetricOptions(
  pane: ManagedPane,
  options: PaneMetricOptions,
  reason: string
): void {
  const target = pane.terminal.options
  if (options.fontSize !== undefined) {
    target.fontSize = options.fontSize
  }
  if (options.fontFamily !== undefined) {
    target.fontFamily = options.fontFamily
  }
  if (options.fontWeight !== undefined) {
    recordMetricWeightChange(pane, 'fontWeight', target.fontWeight, options.fontWeight, reason)
    target.fontWeight = options.fontWeight as typeof target.fontWeight
  }
  if (options.fontWeightBold !== undefined) {
    recordMetricWeightChange(
      pane,
      'fontWeightBold',
      target.fontWeightBold,
      options.fontWeightBold,
      reason
    )
    target.fontWeightBold = options.fontWeightBold as typeof target.fontWeightBold
  }
  if (options.lineHeight !== undefined) {
    target.lineHeight = options.lineHeight
  }
}

/** Record actual weight transitions before writing so prev identifies bold-collapse poisoning/healing (STA-4042). */
function recordMetricWeightChange(
  pane: ManagedPane,
  key: 'fontWeight' | 'fontWeightBold',
  prev: string | number | undefined,
  next: string | number,
  reason: string
): void {
  if (prev === next) {
    return
  }
  recordTerminalWebglDiagnostic('metric-weight-change', {
    paneId: pane.id,
    key,
    prev: prev === undefined ? null : String(prev),
    next: String(next),
    reason
  })
}
