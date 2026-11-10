import type { WorktreeMeta } from '../../../../../../shared/worktree/meta-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type {
  HostedReviewLinkKey,
  RuntimeWorktreeMetaUpdates
} from '../listing/worktree-slice-types'

export function getHostedReviewLinkForMetaRefresh(
  updates: Partial<WorktreeMeta>,
  existingWorktree: Worktree | undefined,
  key: HostedReviewLinkKey
): number | null {
  return Object.hasOwn(updates, key) ? (updates[key] ?? null) : (existingWorktree?.[key] ?? null)
}

export function hasExplicitPushTargetClear(updates: Partial<WorktreeMeta>): boolean {
  return Object.hasOwn(updates, 'pushTarget') && updates.pushTarget === undefined
}

export function encodePushTargetClearForRuntimeRpc(
  updates: Partial<WorktreeMeta>
): RuntimeWorktreeMetaUpdates {
  if (!hasExplicitPushTargetClear(updates)) {
    return updates
  }
  // Why: remote runtime RPC is JSON-shaped and drops undefined, so null is the wire signal for clearing persisted pushTarget metadata.
  return { ...updates, pushTarget: null }
}
