// The one definition of "what the visible terminal screen says", shared by the main-process
// headless emulator and the renderer's xterm.js pane. Both run the same xterm buffer API, so
// a detector fed by either sees a character-identical string — which is the point: the
// credential-prompt guard is only as good as the agreement between the lane that produces its
// input and the lane that produced the corpus it was tuned on.

import { detectTerminalComposerDraft, type TerminalComposerDraft } from './terminal-composer-draft'
import {
  readTerminalCursorLineContext,
  type TerminalCursorContextSource
} from './terminal-cursor-line-context'

/** Minimal xterm surface satisfied by both `@xterm/headless` and `@xterm/xterm` terminals. */
export type TerminalVisibleScreenSource = TerminalCursorContextSource

/** The rows currently on screen, top to bottom, right-trimmed and blank-padded. */
export function readTerminalVisibleLines(terminal: TerminalVisibleScreenSource): string[] {
  const buffer = terminal.buffer.active
  const lines: string[] = []
  for (let row = buffer.viewportY; row < buffer.viewportY + terminal.rows; row += 1) {
    lines.push(buffer.getLine(row)?.translateToString(true) ?? '')
  }
  return lines
}

export function visibleNonBlankTerminalLines(lines: string[]): string[] {
  return lines.map((line) => line.trimEnd()).filter((line) => line.trim().length > 0)
}

/** Why the composer rows collapse: what the user is typing is not output the screen "says". */
export function collapseTerminalComposerDraftRows(
  visible: string[],
  draft: TerminalComposerDraft | null
): { lines: string[]; draft?: string } {
  if (draft) {
    visible[draft.promptRow] = draft.promptGlyph
    for (let row = draft.promptRow + 1; row <= draft.endRow; row += 1) {
      visible[row] = ''
    }
  }
  return {
    lines: visibleNonBlankTerminalLines(visible),
    ...(draft ? { draft: draft.text } : {})
  }
}

export function projectTerminalVisibleScreen(terminal: TerminalVisibleScreenSource): {
  lines: string[]
  draft?: string
} {
  return collapseTerminalComposerDraftRows(
    readTerminalVisibleLines(terminal),
    detectTerminalComposerDraft(readTerminalCursorLineContext(terminal, terminal.rows))
  )
}

/**
 * The exact string a wait/blocked detector is handed on the visible-screen path: the projected
 * non-blank rows joined by newline. Main builds it as `projection.tail.join('\n')`; anything
 * reading a live xterm must build it here rather than re-deriving its own row walk.
 */
export function buildTerminalVisibleScreenText(terminal: TerminalVisibleScreenSource): string {
  return projectTerminalVisibleScreen(terminal).lines.join('\n')
}
