/**
 * Tracks the current typed-but-unsubmitted input line for terminal
 * autosuggest, driven by either OSC133 delivery path: main-authority
 * `pty:sideEffect` facts (onPromptEndFact/onCommandStartedFact) or the
 * renderer byte-mode scanner (handlePtyData, wired in a later task).
 *
 * Why two-phase capture: OSC133;B (prompt-end) fires once the prompt is
 * drawn but before the user types, so we snapshot the cursor position then
 * and re-read the buffer from that column up to the live cursor on demand —
 * this avoids re-parsing prompt text and tolerates prompts of any shape.
 */
import type { Terminal } from '@xterm/xterm'

export type TerminalAutosuggestLineTracker = {
  /** Feed one raw PTY chunk (byte-mode path only — no-op if fact-driven). */
  handlePtyData: (data: string) => void
  /** Call when a pty:sideEffect 'prompt-end' fact arrives (fact-driven path). */
  onPromptEndFact: () => void
  /** Call when a pty:sideEffect 'command-started' fact arrives (fact-driven path). */
  onCommandStartedFact: () => void
  /** Current typed-but-unsubmitted input line, or null if not at a tracked prompt. */
  getCurrentInputLine: () => string | null
  dispose: () => void
}

export function createTerminalAutosuggestLineTracker(
  terminal: Terminal
): TerminalAutosuggestLineTracker {
  let promptEndColumn: number | null = null
  let promptRow: number | null = null

  const capturePromptEnd = (): void => {
    const buffer = terminal.buffer.active
    promptEndColumn = buffer.cursorX
    promptRow = buffer.baseY + buffer.cursorY
  }

  const reset = (): void => {
    promptEndColumn = null
    promptRow = null
  }

  return {
    handlePtyData: () => {
      // Byte-mode path: prompt-end/command-started arrive via the scanner
      // upstream (Task 4's terminal-command-lifecycle), which calls
      // onPromptEndFact/onCommandStartedFact directly — this method exists
      // for interface symmetry with the fact-driven path and is a no-op.
    },
    onPromptEndFact: capturePromptEnd,
    onCommandStartedFact: reset,
    getCurrentInputLine: () => {
      if (promptEndColumn === null || promptRow === null) {
        return null
      }
      const buffer = terminal.buffer.active
      const currentRow = buffer.baseY + buffer.cursorY
      // Why: a row mismatch means the user scrolled or a new line appeared
      // some other way since prompt-end — the captured column no longer
      // means anything on this row.
      if (currentRow !== promptRow) {
        return null
      }
      const line = buffer.getLine(currentRow)
      if (!line) {
        return null
      }
      return line.translateToString(true, promptEndColumn, buffer.cursorX)
    },
    dispose: reset
  }
}
