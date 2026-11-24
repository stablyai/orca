import type { TerminalScrollIntentTarget } from './terminal-scroll-intent'

// Viewport repositioning must wait for pinned reading to end; the next follow-output intent releases all one-shot waiters.
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
