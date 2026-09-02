import {
  captureTerminalStructuralScrollIntent,
  restoreTerminalStructuralScrollIntent,
  type TerminalScrollIntentTarget
} from './terminal-scroll-intent'
import {
  beginTerminalScrollIntentBufferRebuild,
  cancelTerminalScrollIntentBufferRebuildCompletions,
  endTerminalScrollIntentBufferRebuild
} from './terminal-scroll-intent-rebuild'
import { cancelDeferredScrollRestore } from './pane-scroll'

type StructuralReplayTask = () => void | Promise<void>

type StructuralReplayOptions = {
  shouldRestore?: () => boolean
  afterRestore?: () => void | Promise<void>
}

export type TerminalStructuralReplayCoordinator = {
  run: (task: StructuralReplayTask, options?: StructuralReplayOptions) => Promise<void>
  dispose: () => void
}

// Why: clear-and-replay bytes parse later and can overlap. One pane-scoped
// queue prevents dimension changes and stale viewport restores from interleaving.
export function createTerminalStructuralReplayCoordinator(
  terminal: TerminalScrollIntentTarget
): TerminalStructuralReplayCoordinator {
  let disposed = false
  let activeCancellation: (() => void) | null = null
  let tail = Promise.resolve()

  const run = (
    task: StructuralReplayTask,
    options: StructuralReplayOptions = {}
  ): Promise<void> => {
    const completion = tail
      .catch(() => undefined)
      .then(async () => {
        if (disposed) {
          return
        }
        const intent = captureTerminalStructuralScrollIntent(terminal)
        // Why: a pre-replay fit retry can otherwise run after this transaction
        // and restore a stale marker over the authoritative replay viewport.
        cancelDeferredScrollRestore(terminal)
        beginTerminalScrollIntentBufferRebuild(terminal)
        let cancelTask = (): void => {}
        const cancellation = new Promise<void>((resolve) => {
          cancelTask = resolve
        })
        activeCancellation = () => {
          cancelTask()
        }
        try {
          const taskCompletion = Promise.resolve(task())
          await Promise.race([taskCompletion, cancellation])
        } finally {
          endTerminalScrollIntentBufferRebuild(terminal)
          try {
            const shouldRestore = !disposed && options.shouldRestore?.() !== false
            if (shouldRestore) {
              restoreTerminalStructuralScrollIntent(terminal, intent, { restoreBy: 'bottomOffset' })
              // Why: live bytes must remain serialized behind replay until any
              // post-restore fit has produced the authoritative destination grid.
              await Promise.race([Promise.resolve(options.afterRestore?.()), cancellation])
            }
          } finally {
            activeCancellation = null
          }
        }
      })
    tail = completion
    return completion
  }

  return {
    run,
    dispose: () => {
      if (disposed) {
        return
      }
      disposed = true
      // Why: a torn-down terminal may silently drop write callbacks. Release
      // the rebuild without sampling its half-parsed buffer into the keyed pin.
      cancelTerminalScrollIntentBufferRebuildCompletions(terminal)
      activeCancellation?.()
    }
  }
}
