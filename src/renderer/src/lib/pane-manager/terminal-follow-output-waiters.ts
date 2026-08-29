import type { TerminalScrollIntentTarget } from './terminal-scroll-intent'

// Why: work that repositions the viewport (clear-and-replay repaints) must wait
// out a pinned reading position instead of racing it on a timer. Waiters are
// one-shot: the intent write that turns follow-output back on releases them all.
const followOutputWaitersByTerminal = new WeakMap<TerminalScrollIntentTarget, Set<() => void>>()

/** Registers a one-shot listener for the terminal's next follow-output intent; returns a canceller. */
export function addTerminalFollowOutputWaiter(
  terminal: TerminalScrollIntentTarget,
  listener: () => void
): () => void {
  const waiters = followOutputWaitersByTerminal.get(terminal) ?? new Set<() => void>()
  followOutputWaitersByTerminal.set(terminal, waiters)
  waiters.add(listener)
  return () => {
    waiters.delete(listener)
  }
}

export function notifyTerminalFollowOutputWaiters(terminal: TerminalScrollIntentTarget): void {
  const waiters = followOutputWaitersByTerminal.get(terminal)
  if (!waiters?.size) {
    return
  }
  followOutputWaitersByTerminal.delete(terminal)
  for (const waiter of waiters) {
    waiter()
  }
}
