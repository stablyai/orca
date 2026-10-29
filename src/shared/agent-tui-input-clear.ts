// Share multiline TUI clearing across desktop/mobile; the rule belongs to Claude/Codex inputs, not clients.

/** Ctrl+U — clears toward the start of the input buffer. */
export const AGENT_TUI_CLEAR_INPUT_LINE = '\x15'

/** Ctrl+K — clears toward the end of the input buffer. */
export const AGENT_TUI_CLEAR_INPUT_FORWARD = '\x0b'

/** Clear up to `lineCount` logical lines from any cursor position. */
export function buildAgentTuiClearInput(lineCount: number): string {
  const lines = Math.max(1, Math.min(AGENT_TUI_CLEAR_MAX_LINES, Math.floor(lineCount)))
  const repetitions = 2 * lines - 1
  return (
    AGENT_TUI_CLEAR_INPUT_LINE.repeat(repetitions) +
    AGENT_TUI_CLEAR_INPUT_FORWARD.repeat(repetitions)
  )
}

/** Injected line count is a lower bound because users type too. Bias upward: 41 Ctrl+U cleanly cleared a one-line buffer on both agents; undershoot leaves residue for the next send. */
export const AGENT_TUI_CLEAR_LINE_SLACK = 8

/** Bounds the burst so a pathological draft cannot emit an unbounded write. */
export const AGENT_TUI_CLEAR_MAX_LINES = 40

/** Widest burst we ever send — the remedy when a clear is not observed to land. */
export const AGENT_TUI_CLEAR_INPUT_MAX = buildAgentTuiClearInput(AGENT_TUI_CLEAR_MAX_LINES)

/** Logical lines in `text`. Visual wrapping is irrelevant to the clear cost. */
export function countAgentTuiInputLines(text: string): number {
  return text.split(/\r\n|\r|\n/).length
}

/** Clear bytes for a buffer believed to hold `text`, with slack for TUI-side edits. */
export function buildAgentTuiClearInputForText(text: string): string {
  return buildAgentTuiClearInput(countAgentTuiInputLines(text) + AGENT_TUI_CLEAR_LINE_SLACK)
}
