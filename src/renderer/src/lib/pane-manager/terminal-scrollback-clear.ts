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
  terminal.scrollToBottom()
  markTerminalFollowOutput(terminal)
}
