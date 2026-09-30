import { isDocumentVisibilityProvenStale } from '../stale-document-visibility'
import {
  scanSynchronizedOutput,
  type SynchronizedOutputScan
} from '../../../../../shared/terminal-synchronized-output-scan'
import {
  INACTIVE_FOREGROUND_IMMEDIATE_BUDGET_CHARS,
  consumeForegroundImmediateBudget,
  createForegroundImmediateBudget
} from './foreground-output-budgets'

export const TERMINAL_RENDERER_RISK_SCAN_TAIL_CHARS = 256
export {
  SYNCHRONIZED_OUTPUT_START_SEQUENCE,
  SYNCHRONIZED_OUTPUT_END_SEQUENCE,
  SYNCHRONIZED_OUTPUT_MARKER_TAIL_CHARS
} from '../../../../../shared/terminal-synchronized-output-scan'
export const CURSOR_SHOW_SEQUENCE = '\x1b[?25h'
export const CURSOR_HIDE_SEQUENCE = '\x1b[?25l'
export const TERMINAL_FOCUS_IN_SEQUENCE = '\x1b[I'
export const TERMINAL_FOCUS_OUT_SEQUENCE = '\x1b[O'
export const FOCUS_REPORTING_DISABLE_SEQUENCE = '\x1b[?1004l'
export const REATTACH_IDLE_AGENT_CURSOR_RESET_DELAY_MS = 250
export const SHIFT_ENTER_RECONFIRM_IDLE_MS = 350

const inactiveForegroundImmediateBudget = createForegroundImmediateBudget()

export function shouldWritePtyOutputForeground(isPaneVisible: boolean): boolean {
  if (!isPaneVisible) {
    return false
  }
  if (typeof document === 'undefined') {
    return true
  }
  // Why: Electron can keep visible panes mounted while the whole app is
  // backgrounded. Treat hidden documents like background tabs so Chromium
  // timer throttling cannot pin terminal writes on the renderer foreground path.
  if (document.visibilityState === 'visible') {
    return true
  }
  // Why: macOS occlusion tracking can wedge visibilityState at 'hidden' after
  // display sleep; proven-stale means real user input contradicted it, so the
  // hidden-delivery gate must not keep dropping a watched pane's bytes.
  return isDocumentVisibilityProvenStale()
}

export type SynchronizedForegroundScan = SynchronizedOutputScan

/** Renderer-facing name for the shared latch scan; the logic is protocol, not view. */
export function scanSynchronizedForegroundOutput(
  data: string,
  markerTail: string,
  wasActive: boolean
): SynchronizedForegroundScan {
  return scanSynchronizedOutput(data, markerTail, wasActive)
}

export function containsCursorPositionSequence(data: string): boolean {
  let offset = data.indexOf('\x1b[')
  while (offset !== -1) {
    let index = offset + 2
    while (index < data.length) {
      const char = data[index]
      if (char === 'G' || char === 'H' || char === 'f') {
        return true
      }
      if ((char < '0' || char > '9') && char !== ';') {
        break
      }
      index += 1
    }
    offset = data.indexOf('\x1b[', offset + 2)
  }
  return false
}

export function containsCursorRestore(data: string): boolean {
  const hideIndex = data.indexOf(CURSOR_HIDE_SEQUENCE)
  const showIndex = data.lastIndexOf(CURSOR_SHOW_SEQUENCE)
  return hideIndex !== -1 && showIndex > hideIndex && containsCursorPositionSequence(data)
}

export function consumeInactiveForegroundImmediateBudget(dataLength: number): boolean {
  return consumeForegroundImmediateBudget(
    inactiveForegroundImmediateBudget,
    dataLength,
    INACTIVE_FOREGROUND_IMMEDIATE_BUDGET_CHARS
  )
}
