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
  void callRuntimeRpc<LayoutApplyReply>(target, 'layout.apply', {
    command: { ...command, workspace: worktreeId }
  })
    .then(
      (reply) =>
        afterLayoutFrame(reply.frameSeq, () => answer(reply), layoutFramePositionKey(target)),
      (error: unknown) => {
        // Why: a thrown write is rolled back. An indeterminate disk write is not, and may leave a
        // pane main minted, which its frame then draws. Never sent again: main may have applied it.
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
