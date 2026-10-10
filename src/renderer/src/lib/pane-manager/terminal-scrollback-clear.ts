import { ensureImmediateTerminalScroll } from './terminal-wheel-smooth-scroll'
import { markTerminalFollowOutput, type TerminalScrollIntentTarget } from './terminal-scroll-intent'

type TerminalScrollbackClearTarget = TerminalScrollIntentTarget & {
  clear: () => void
  scrollToBottom: () => void
}

export function clearTerminalScrollbackAndFollowOutput(
  terminal: TerminalScrollbackClearTarget
): void {
  terminal.clear()
  // Why: xterm clear() leaves BufferService.isUserScrolling latched when the
  // viewport was pinned, so a public zero-distance bottom scroll must reset it.
  ensureImmediateTerminalScroll(terminal)
  terminal.scrollToBottom()
  markTerminalFollowOutput(terminal)
}
