import type { Terminal } from '@xterm/xterm'
import { detectTerminalComposerDraft } from '../../../../shared/terminal-composer-draft'
import { readTerminalCursorLineContext } from '../../../../shared/terminal-cursor-line-context'

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
export function readTerminalComposerDraftPresence(terminal: Terminal): boolean | null {
  // Why: a pane detached from the DOM has no painted screen to read, and its
  // buffer may be mid-replay — answering would be a coin flip, so say nothing.
  if (!terminal.element?.isConnected) {
    return null
  }
  const draft = detectTerminalComposerDraft(readTerminalCursorLineContext(terminal, terminal.rows))
  return (draft?.text.trim().length ?? 0) > 0
}
