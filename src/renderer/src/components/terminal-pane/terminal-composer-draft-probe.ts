import { detectTerminalComposerDraft } from '../../../../shared/terminal-composer-draft'
import {
  readTerminalCursorLineContext,
  type TerminalCursorContextSource
} from '../../../../shared/terminal-cursor-line-context'

/** Structural, so a test can hand this an unreadable screen without an xterm. */
export type TerminalComposerDraftSource = TerminalCursorContextSource & {
  readonly element?: HTMLElement | null
}

/**
 * Whether the agent's composer in this pane is holding text the user has not sent,
 * or null when the pane cannot be read right now.
 *
 * Reads the painted screen, which is the only place a TUI agent's unsent input
 * exists. `detectTerminalComposerDraft` already rejects a stock placeholder
 * ("Try …", "Ask Codex to do anything"), so an idle pane answers false.
 *
 * Only recognises the composers whose prompt frame the detector knows —
 * Claude Code and Codex today. Any other agent answers false rather than guess.
 */
export function readTerminalComposerDraftPresence(
  terminal: TerminalComposerDraftSource
): boolean | null {
  // Why: a pane detached from the DOM has no painted screen to read, and its
  // buffer may be mid-replay — answering would be a coin flip, so say nothing.
  if (!terminal.element?.isConnected) {
    return null
  }
  const context = readTerminalCursorLineContext(terminal, terminal.rows)
  // Why: no cursor line means the screen cannot be read at all, which is not the
  // same as an empty composer — answering false would retire a live marker.
  if (!context) {
    return null
  }
  const draft = detectTerminalComposerDraft(context)
  return (draft?.text.trim().length ?? 0) > 0
}
