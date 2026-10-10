import { resolveAutoPlacementGroupId } from '@/store/slices/tabs/lone-pane-split-source'
import { useAppStore } from '../store'
import type { CreateWebRuntimeSessionTerminalArgs } from './web-runtime-session-types'

type WebRuntimeTerminalTargetGroup = {
  targetGroupId: string | undefined
  /** Set only when this call itself split the group off, so a failed create can reap it. */
  mintedGroupId: string | undefined
}

/** The group a remote terminal lands in. Remote terminals never reach `createTab`, so the
 *  automatic placement rule lives here too — same mechanism, and the create operation already
 *  honours a caller-supplied group, so nothing on the client/host wire changes. */
export function resolveWebRuntimeTerminalTargetGroupId(
  args: Pick<CreateWebRuntimeSessionTerminalArgs, 'worktreeId' | 'targetGroupId' | 'placementFixed'>
): WebRuntimeTerminalTargetGroup {
  if (args.placementFixed) {
    return { targetGroupId: args.targetGroupId, mintedGroupId: undefined }
  }
  const before = new Set(
    (useAppStore.getState().groupsByWorktree?.[args.worktreeId] ?? []).map((group) => group.id)
  )
  const targetGroupId =
    resolveAutoPlacementGroupId(
      useAppStore.getState(),
      args.worktreeId,
      args.targetGroupId,
      'terminal'
    ) ?? args.targetGroupId
  return {
    targetGroupId,
    // Why absence-before rather than a flag from the split helper: a group that already existed
    // was either reused or caller-supplied, and neither is ours to close.
    mintedGroupId:
      targetGroupId !== undefined && !before.has(targetGroupId) ? targetGroupId : undefined
  }
}
