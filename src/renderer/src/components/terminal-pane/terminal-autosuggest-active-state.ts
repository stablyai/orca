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

// Why: returns null (not an empty remainder) during a paste, mid-edit, or with no
// matching candidate, so the overlay never shows a suggestion that isn't real.
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
