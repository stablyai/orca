import type { Terminal } from '@xterm/xterm'
import { bestAutosuggestMatch } from './terminal-autosuggest-engine'
import type { TerminalAutosuggestLineTracker } from './terminal-autosuggest-line-tracker'

export type ActiveAutosuggestState = {
  terminal: Terminal
  /** Absolute buffer row (baseY + cursorY) of the cursor. */
  row: number
  /** Cursor column, where the ghost remainder begins. */
  cursorCol: number
  /** Text to append after the current input to reach the matched command. */
  remainder: string
  foregroundColor: string
}

/**
 * Derives the ghost-text overlay state for a pane, or null when nothing should
 * show. Pure so it stays testable without React/xterm — the caller supplies the
 * candidate pool (session + persisted history, most-recent-first) and the theme
 * foreground color.
 *
 * Suppressed (returns null, not an empty remainder) when: bracketed paste is
 * active (a paste is landing, not typed input), the cursor is not exactly at
 * end-of-input (mid-edit or navigated past the text), there is no tracked input,
 * or no candidate extends the current input.
 */
export function computeActiveAutosuggestState(
  terminal: Terminal,
  lineTracker: Pick<
    TerminalAutosuggestLineTracker,
    'getCurrentInputLine' | 'isCursorAtEndOfInputLine'
  >,
  candidates: readonly string[],
  foregroundColor: string
): ActiveAutosuggestState | null {
  if (terminal.modes.bracketedPasteMode) {
    return null
  }
  if (!lineTracker.isCursorAtEndOfInputLine()) {
    return null
  }
  const currentInput = lineTracker.getCurrentInputLine()
  if (currentInput === null) {
    return null
  }
  const match = bestAutosuggestMatch(candidates, currentInput)
  if (!match) {
    return null
  }
  const buffer = terminal.buffer.active
  return {
    terminal,
    row: buffer.baseY + buffer.cursorY,
    cursorCol: buffer.cursorX,
    remainder: match.slice(currentInput.length),
    foregroundColor
  }
}
