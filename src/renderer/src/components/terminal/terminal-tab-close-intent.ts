import type { TerminalTabCloseReason } from '@/store/terminals/terminal-tab-retirement'
import type { RuntimeSessionTabCloseReason } from '../../../../shared/runtime-types'

/**
 * Who declared a terminal tab close, so only real intent reaches a host's destructive close (#37245).
 * - user: this window's user gesture (X, menu, shortcut, confirmed dialog).
 * - requested: an authorized actor outside this window (CLI, RPC, paired phone) asked main to close it.
 * - cleanup: the window's own housekeeping; a paired host keeps a live terminal.
 * - pty-exit: the tab's process ended.
 */
export type TerminalTabCloseIntent = TerminalTabCloseReason | 'requested'

/** The local store records an explicit close for both user and requested closes. */
export function terminalTabCloseStoreReason(
  intent: TerminalTabCloseIntent
): TerminalTabCloseReason {
  return intent === 'requested' ? 'user' : intent
}

/** session.tabs.close's 'user' is every host version's only destructive close; other intents need lifecycle evidence. */
export function terminalTabCloseWireReason(
  intent: TerminalTabCloseIntent
): RuntimeSessionTabCloseReason {
  return intent === 'requested' ? 'user' : intent
}
