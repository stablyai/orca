import { markTerminalFollowOutput, type TerminalScrollIntentTarget } from './terminal-scroll-intent'

type TerminalScrollbackClearTarget = TerminalScrollIntentTarget & {
  clear: () => void
  scrollToBottom: () => void
}

export function clearTerminalScrollbackAndFollowOutput(
  terminal: TerminalScrollbackClearTarget
): void {
  terminal.clear()
  // clear() leaves native isUserScrolling latched; a zero-distance bottom scroll resets it.
  terminal.scrollToBottom()
  markTerminalFollowOutput(terminal)
}
