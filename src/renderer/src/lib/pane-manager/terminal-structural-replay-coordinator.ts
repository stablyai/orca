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
import {
  beginTerminalReplayPresentation,
  type TerminalReplayPresentationTarget
} from './terminal-replay-presentation'

type StructuralReplayTask = () => void | Promise<void>

type StructuralReplayOptions = {
  shouldRestore?: () => boolean
  afterRestore?: () => void | Promise<void>
}

export type TerminalStructuralReplayCoordinator = {
  run: (task: StructuralReplayTask, options?: StructuralReplayOptions) => Promise<void>
  dispose: () => void
}

// Serialize pane rebuilds so asynchronous replay cannot interleave dimensions or stale viewport restoration.
export function createTerminalStructuralReplayCoordinator(
  terminal: TerminalScrollIntentTarget & TerminalReplayPresentationTarget
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
        // Cancel pre-replay fit retries before they can overwrite the authoritative viewport with stale markers.
        cancelDeferredScrollRestore(terminal)
        beginTerminalScrollIntentBufferRebuild(terminal)
        const releasePresentation = beginTerminalReplayPresentation(terminal)
        let shouldPresent = false
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
              // Hold live bytes behind replay until post-restore fit establishes the authoritative destination grid.
              await Promise.race([Promise.resolve(options.afterRestore?.()), cancellation])
              shouldPresent = true
            }
          } finally {
            releasePresentation(!disposed && shouldPresent)
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
      // Torn-down xterm can silently drop callbacks; release rebuild without sampling half-parsed geometry into the keyed pin.
      cancelTerminalScrollIntentBufferRebuildCompletions(terminal)
      activeCancellation?.()
    }
  }
}
