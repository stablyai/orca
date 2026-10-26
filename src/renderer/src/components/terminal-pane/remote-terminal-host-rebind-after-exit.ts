import {
  subscribeAcceptedWebSessionTerminalHandle,
  type WebSessionTerminalHandleUpdate
} from '../../runtime/web-session-terminal-handle-events'
import { sameWhenBothKnown } from './remote-terminal-host-exit-record'

export type HostRebindAfterExitWatch = {
  /** Starts judging updates against the settled exit, the one seen while probing included. */
  arm: (exitedHandle: string, exitedIncarnationId: string | null) => void
  dispose: () => void
}

/** Fires once the host publishes a provably different live process for an exit-settled pane. */
export function watchHostRebindAfterExit(
  args: { environmentId: string; worktreeId: string; hostTabId: string; leafId: string },
  onRebound: (handle: string) => void
): HostRebindAfterExitWatch {
  let stopped = false
  let exited: { handle: string; incarnationId: string | null } | null = null
  // Why buffered: the replacement can be published while the exit probe is still confirming.
  let latest: WebSessionTerminalHandleUpdate | null = null
  const judge = (update: WebSessionTerminalHandleUpdate): void => {
    if (stopped || !exited) {
      return
    }
    if (!update.surfacePresent) {
      dispose()
      return
    }
    const next = update.terminalHandle
    if (
      !next ||
      (next === exited.handle && sameWhenBothKnown(update.incarnationId, exited.incarnationId))
    ) {
      return
    }
    dispose()
    onRebound(next)
  }
  const stop = subscribeAcceptedWebSessionTerminalHandle(args, (update) => {
    latest = update
    judge(update)
  })
  function dispose(): void {
    stopped = true
    stop()
  }
  return {
    arm(exitedHandle, exitedIncarnationId) {
      exited = { handle: exitedHandle, incarnationId: exitedIncarnationId }
      if (latest) {
        judge(latest)
      }
    },
    dispose
  }
}
