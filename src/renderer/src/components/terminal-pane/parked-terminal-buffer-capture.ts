import {
  shouldPreserveTerminalScrollbackBuffers,
  type RepoConnection
} from '../../../../shared/workspace-session-terminal-buffers'
import {
  captureTerminalShutdownBuffersBestEffort,
  shutdownBufferCaptures
} from './shutdown-buffer-captures'

type ParkedTerminalCaptureArgs = {
  worktreeId: string
  tabIds: readonly string[]
  repos: readonly RepoConnection[]
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  )
}

/** Serialize a parked worktree's panes before the park unmounts them.
 *  Why every park and not only force-park: a remote-runtime pane's bytes never transit main, so its
 *  xterm buffer is the only client-side copy. Local worktrees stay exempt — includeLocalBuffers:false
 *  serializes nothing for them. Returns whether the episode covered every tab; false leaves it
 *  unmarked so a later episode retries. A Promise means at least one pane still has to yield. */
export function captureParkedTerminalBuffers({
  worktreeId,
  tabIds,
  repos
}: ParkedTerminalCaptureArgs): boolean | Promise<boolean> {
  // Why skip local worktrees: includeLocalBuffers:false serializes nothing for them, so the only
  // effect left is setTabLayout replacing away a stored buffer (e.g. an exited setup pane's output).
  if (!shouldPreserveTerminalScrollbackBuffers(worktreeId, repos)) {
    return true
  }
  if (tabIds.length === 0) {
    return true
  }
  if (!tabIds.some((tabId) => shutdownBufferCaptures.has(tabId))) {
    return false
  }
  return captureTerminalShutdownBuffersBestEffort(tabIds, {
    includeLocalBuffers: false,
    yieldBetweenPanes: true
  }).then((result) => result.captured === result.requested)
}

/** Increment a generation so an overlapping later pass can drop this one's settlement. */
export function beginParkedCapturePass(generation: { current: number }): {
  isCurrent: () => boolean
} {
  const passGeneration = generation.current + 1
  generation.current = passGeneration
  return {
    isCurrent: () => generation.current === passGeneration
  }
}

export function whenParkedCaptureSettles(
  result: unknown,
  onComplete: () => void,
  isCurrent?: () => boolean
): void {
  const complete = (): void => {
    if (isCurrent && !isCurrent()) {
      return
    }
    onComplete()
  }
  if (isThenable(result)) {
    void result.then(complete, complete)
    return
  }
  complete()
}

export function enqueueParkedTerminalCapture(
  result: boolean | Promise<boolean>,
  onOk: () => void,
  pending: Promise<unknown>[],
  isCurrent?: () => boolean
): void {
  const accept = (): void => {
    if (isCurrent && !isCurrent()) {
      return
    }
    onOk()
  }
  if (isThenable(result)) {
    pending.push(
      result.then((ok) => {
        if (ok) {
          accept()
        }
      })
    )
    return
  }
  if (result) {
    accept()
  }
}
