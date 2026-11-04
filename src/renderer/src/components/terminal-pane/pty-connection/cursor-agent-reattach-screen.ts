import type { IBuffer } from '@xterm/xterm'
import { resolveCursorAgentImeAnchor } from '@/lib/pane-manager/terminal-ime-anchor'
import { CSI_SEQUENCE_PATTERN } from '../../../../../shared/ansi-escape-sequences'

export type TerminalWithFocusMode = {
  textarea?: HTMLTextAreaElement | null
  modes?: {
    sendFocusMode?: boolean
  }
}

export type TerminalWithInspectableBuffer = {
  cols: number
  rows: number
  buffer?: {
    active?: IBuffer
  }
}

// Require both current Cursor screen shape and a parked cursor; replay can retain a dead run’s frame above a shell prompt. Uninspectable buffers return null.
export function parsedViewportShowsParkedCursorAgentScreen(
  terminal: TerminalWithInspectableBuffer
): boolean | null {
  const buffer = terminal.buffer?.active
  if (
    !buffer ||
    typeof buffer.getLine !== 'function' ||
    typeof buffer.cursorX !== 'number' ||
    typeof buffer.cursorY !== 'number'
  ) {
    return null
  }
  return (
    resolveCursorAgentImeAnchor({
      buffer,
      rows: terminal.rows,
      cols: terminal.cols,
      cursorX: buffer.cursorX,
      cursorY: buffer.cursorY
    }) !== null
  )
}

export function terminalHasFocusReportingEnabled(terminal: TerminalWithFocusMode): boolean {
  return terminal.modes?.sendFocusMode === true
}

export function terminalOwnsDomFocus(terminal: TerminalWithFocusMode): boolean {
  if (typeof document === 'undefined' || !terminal.textarea) {
    return false
  }
  return document.activeElement === terminal.textarea
}

export const CURSOR_AGENT_REATTACH_HEADER = 'Cursor Agent'
const CURSOR_AGENT_REATTACH_INPUT_MARKER = '→'
const CURSOR_AGENT_REATTACH_SCREEN_SIGNAL_MAX_CHARS = 5000
// Scan the last 256KB, enough for a fully styled current frame; earlier headers belong to stale scrollback.
const CURSOR_AGENT_REATTACH_SCAN_TAIL_LIMIT_CHARS = 256 * 1024

export function hasCursorAgentReattachPayloadScreenSignal(data: string): boolean {
  const tail =
    data.length > CURSOR_AGENT_REATTACH_SCAN_TAIL_LIMIT_CHARS
      ? data.slice(-CURSOR_AGENT_REATTACH_SCAN_TAIL_LIMIT_CHARS)
      : data
  // Strip only CSI so OSC-carried titles retain header semantics.
  const normalized = tail.replace(CSI_SEQUENCE_PATTERN, '')
  // Use the last header; replay may also retain earlier finished runs.
  const headerIndex = normalized.lastIndexOf(CURSOR_AGENT_REATTACH_HEADER)
  if (headerIndex === -1) {
    return false
  }
  const screenTail = normalized.slice(
    headerIndex + CURSOR_AGENT_REATTACH_HEADER.length,
    headerIndex + CURSOR_AGENT_REATTACH_SCREEN_SIGNAL_MAX_CHARS
  )
  return screenTail.includes(`${CURSOR_AGENT_REATTACH_INPUT_MARKER} `)
}
