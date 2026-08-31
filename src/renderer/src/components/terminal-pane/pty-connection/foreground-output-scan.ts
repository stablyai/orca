import { isDocumentVisibilityProvenStale } from '../stale-document-visibility'
import {
  INACTIVE_FOREGROUND_IMMEDIATE_BUDGET_CHARS,
  consumeForegroundImmediateBudget,
  createForegroundImmediateBudget
} from './foreground-output-budgets'

export const TERMINAL_RENDERER_RISK_SCAN_TAIL_CHARS = 256
export const SYNCHRONIZED_OUTPUT_START_SEQUENCE = '\x1b[?2026h'
export const SYNCHRONIZED_OUTPUT_END_SEQUENCE = '\x1b[?2026l'
export const SYNCHRONIZED_OUTPUT_MARKER_TAIL_CHARS = SYNCHRONIZED_OUTPUT_START_SEQUENCE.length - 1
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

export type SynchronizedForegroundScan = {
  started: boolean
  ended: boolean
  active: boolean
  markerTail: string
}

// Why the carried tail: ConPTY can split \x1b[?2026l across chunks; scanning the raw
// chunk alone left the foreground DEC 2026 latch stuck open so every later chunk was
// held instead of coalesced, freezing the visible pane (#8754). Mirrors the hidden path.
export function scanSynchronizedForegroundOutput(
  data: string,
  markerTail: string,
  wasActive: boolean
): SynchronizedForegroundScan {
  const scanData = markerTail ? `${markerTail}${data}` : data
  const currentChunkStartIndex = scanData.length - data.length
  let active = wasActive
  let started = false
  let ended = false
  let offset = 0

  while (offset < scanData.length) {
    const startIndex = scanData.indexOf(SYNCHRONIZED_OUTPUT_START_SEQUENCE, offset)
    const endIndex = scanData.indexOf(SYNCHRONIZED_OUTPUT_END_SEQUENCE, offset)
    if (startIndex === -1 && endIndex === -1) {
      break
    }
    if (endIndex !== -1 && (startIndex === -1 || endIndex < startIndex)) {
      active = false
      if (endIndex + SYNCHRONIZED_OUTPUT_END_SEQUENCE.length > currentChunkStartIndex) {
        ended = true
      }
      offset = endIndex + SYNCHRONIZED_OUTPUT_END_SEQUENCE.length
      continue
    }
    active = true
    if (startIndex + SYNCHRONIZED_OUTPUT_START_SEQUENCE.length > currentChunkStartIndex) {
      started = true
    }
    offset = startIndex + SYNCHRONIZED_OUTPUT_START_SEQUENCE.length
  }

  return {
    started,
    ended,
    active,
    // Why length-1: a full marker can never hide in the tail, so no marker is counted twice.
    markerTail: scanData.slice(-SYNCHRONIZED_OUTPUT_MARKER_TAIL_CHARS)
  }
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
