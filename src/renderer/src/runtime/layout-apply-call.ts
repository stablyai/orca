// The `layout.apply` call itself: one intent to a main, answered once the frame holding it is in.
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { afterLayoutFrame, layoutFramePositionKey } from '@/runtime/layout-frame-position'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { LayoutApplyReply } from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { WindowLayoutCommand } from './layout-apply-send'

/** `answer` gets the reply once the frame holding it is in, or null when the call failed. */
export function callLayoutApply(
  target: RuntimeClientTarget,
  worktreeId: string,
  command: WindowLayoutCommand,
  answer: (reply: LayoutApplyReply | null) => void
): void {
  void afterWorkspaceLayoutCommands(target, worktreeId, () =>
    callRuntimeRpc<LayoutApplyReply>(target, 'layout.apply', {
      command: { ...command, workspace: worktreeId }
    })
  )
    .then(
      (reply) =>
        afterLayoutFrame(reply.frameSeq, () => answer(reply), layoutFramePositionKey(target)),
      (error: unknown) => {
        // Thrown writes roll back; indeterminate disk writes may leave minted panes main’s frames draw. Never replay a possibly applied intent.
        console.warn(`[layout-owner] ${command.type} refused: call_failed`, errorMessage(error))
        answer(null)
      }
    )
    // A throwing handler is not a failed call; it must not run the fallback too.
    .catch((error: unknown) => {
      console.warn(`[layout-owner] ${command.type} handler threw:`, errorMessage(error))
    })
}

function errorMessage(error: unknown): unknown {
  return error instanceof Error ? error.message : error
}

const pendingWorkspaceCommands = new Map<string, Promise<unknown>>()

/** Creation settles before a later close/split can address its admitted occurrence. */
export function afterWorkspaceLayoutCommands<T>(
  target: RuntimeClientTarget,
  worktreeId: string,
  run: () => Promise<T>
): Promise<T> {
  const key = JSON.stringify([layoutFramePositionKey(target), worktreeId])
  const previous = pendingWorkspaceCommands.get(key)
  const result = previous ? previous.then(run, run) : run()
  pendingWorkspaceCommands.set(key, result)
  const release = (): void => {
    if (pendingWorkspaceCommands.get(key) === result) {
      pendingWorkspaceCommands.delete(key)
    }
  }
  void result.then(release, release)
  return result
}
