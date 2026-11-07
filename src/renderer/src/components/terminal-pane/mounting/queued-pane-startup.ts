import type { PtyPaneStartup } from '../pty-connection-types'

export function paneOwnsQueuedStartup(
  paneStartup: PtyPaneStartup | null | undefined,
  queuedStartup: PtyPaneStartup | null | undefined
): boolean {
  return queuedStartup != null && paneStartup === queuedStartup
}

export function createQueuedStartupConsumer(
  paneStartup: PtyPaneStartup | null | undefined,
  queuedStartup: PtyPaneStartup | null | undefined,
  consume: () => void,
  isStillQueued: () => boolean
): (() => void) | undefined {
  if (!paneOwnsQueuedStartup(paneStartup, queuedStartup)) {
    return undefined
  }
  let spent = false
  return () => {
    if (spent) {
      return
    }
    spent = true
    if (!isStillQueued()) {
      return
    }
    consume()
  }
}
