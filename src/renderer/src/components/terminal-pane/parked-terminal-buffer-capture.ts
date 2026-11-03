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
  /** Ordinary parks keep the bytes client-local; force-parks share them. See ShutdownBufferCaptureOptions. */
  localOnly: boolean
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  )
}

/** Capture every remote park: build capability does not prove retained host bytes, and unavailable snapshots are unverifiable, not empty. False coverage leaves the episode unmarked for retry. A Promise means at least one pane still has to yield (docs/reference/ssh-execution-boundary.md). */
export function captureParkedTerminalBuffers({
  worktreeId,
  tabIds,
  repos,
  localOnly
}: ParkedTerminalCaptureArgs): boolean | Promise<boolean> {
  // Local capture is disabled here; replacing its layout would only erase stored buffers such as exited setup output.
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
    localOnly,
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
