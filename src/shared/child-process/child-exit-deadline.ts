/**
 * Bound on waiting for `close` once the child's exit is known.
 *
 * Why bounded: a descendant that inherited the child's stdio keeps `close`
 * pending after the child itself exits, so an unbounded wait would drop the
 * caller's hang protection.
 */
const EXITED_CHILD_CLOSE_GRACE_MS = 1_000

type ChildExitState = {
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
}

export type ChildExitDeadline = { clear: () => void }

function hasExited(child: ChildExitState): boolean {
  return typeof child.exitCode === 'number' || typeof child.signalCode === 'string'
}

/**
 * Call `onExpired` if the child is still running `timeoutMs` after arming.
 *
 * Why not a bare setTimeout: after the main thread was blocked past the
 * deadline, libuv runs expired timers before the poll phase reads the exit of a
 * child that finished during the block. The verdict waits one loop turn so that
 * pending exit lands first, and a child that already exited is never timed out.
 */
export function armChildExitDeadline(
  child: ChildExitState,
  timeoutMs: number,
  onExpired: () => void
): ChildExitDeadline {
  let immediate: ReturnType<typeof setImmediate> | undefined
  let closeGraceTimer: ReturnType<typeof setTimeout> | undefined
  const judge = (): void => {
    if (!hasExited(child)) {
      onExpired()
      return
    }
    closeGraceTimer = setTimeout(onExpired, EXITED_CHILD_CLOSE_GRACE_MS)
    closeGraceTimer.unref?.()
  }
  // Why the immediate stays ref'd: an unref'd immediate does not stop poll from
  // blocking, so the verdict would wait for unrelated I/O.
  const timer = setTimeout(() => {
    immediate = setImmediate(judge)
  }, timeoutMs)
  timer.unref?.()
  return {
    clear: () => {
      clearTimeout(timer)
      clearTimeout(closeGraceTimer)
      clearImmediate(immediate)
    }
  }
}
