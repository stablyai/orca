import { drainPreHandlerPtyExit, hasPreHandlerPtyExit } from './pty-pre-handler-buffer'
import { ptyDataHandlers, ptyExitHandlers } from './pty-shutdown-data-suspension'

export type PtyExitWatcher = (code: number, context: { hadPrimary: boolean }) => void
export type PtyExitSubscriptionOptions = {
  adoptPreHandlerExit?: boolean
}

export const ptyExitSidecars = new Map<string, Set<PtyExitWatcher>>()

export function registerPtyExitSidecar(
  ptyId: string,
  watcher: PtyExitWatcher,
  options?: PtyExitSubscriptionOptions
): () => void {
  let set = ptyExitSidecars.get(ptyId)
  if (!set) {
    set = new Set()
    ptyExitSidecars.set(ptyId, set)
  }
  set.add(watcher)
  const unsubscribe = (): void => {
    const current = ptyExitSidecars.get(ptyId)
    if (!current) {
      return
    }
    current.delete(watcher)
    if (current.size === 0) {
      ptyExitSidecars.delete(ptyId)
    }
  }
  if (options?.adoptPreHandlerExit && hasPreHandlerPtyExit(ptyId)) {
    // Why: data-derived effects use 0ms timers; FIFO keeps final output ahead of exit cleanup.
    setTimeout(() => {
      const current = ptyExitSidecars.get(ptyId)
      if (!current?.has(watcher) || ptyExitHandlers.has(ptyId) || ptyDataHandlers.has(ptyId)) {
        return
      }
      unsubscribe()
      drainPreHandlerPtyExit(ptyId, (code) => watcher(code, { hadPrimary: false }))
    }, 0)
  }
  return unsubscribe
}
