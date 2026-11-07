import type { ParsedTaskQuery } from '../../../../../shared/task-query'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import { applyTaskPageGitHubListOps } from './task-page-github-work-item-mutation-patches'
import {
  familiesFromPendingOp,
  freezeTaskPageGitHubUsers,
  getRegistryMergedTaskPageGitHubWorkItem,
  recomputeSoftHideForItem
} from './task-page-github-work-item-mutation-composition'
import {
  deletePendingTaskPageGitHubOp,
  getConfirmedListSnapshot,
  getPendingTaskPageGitHubOp,
  getTaskPageGitHubMutationQueryKey,
  listPendingTaskPageGitHubOpsForItem,
  notifyTaskPageGitHubMutationRegistry,
  setConfirmedListSnapshot,
  setLastConfirmedClientValue,
  isTaskPageGitHubMutationQueryKeyCurrent
} from './task-page-github-work-item-mutation-registry'
import { markTaskPageGitHubFamiliesDirty } from './task-page-github-work-item-quiet-state'
import { taskPageGitHubItemKey } from './task-page-github-work-item-mutation-keys'
import type { TaskPageGitHubMutationKey } from './task-page-github-work-item-registry-types'
import type { TaskPageGitHubPatchWorkItem } from './task-page-github-work-item-mutation-types'
function applyServerEntityIfPresent(
  key: TaskPageGitHubMutationKey,
  opts: {
    serverEntity?: Partial<GitHubWorkItem>
    patchWorkItem?: TaskPageGitHubPatchWorkItem
    sourceContext?: TaskSourceContext | null
  }
): void {
  if (!opts.serverEntity || !opts.patchWorkItem) {
    return
  }
  const entityPatch: Partial<GitHubWorkItem> = {}
  if (opts.serverEntity.state !== undefined) {
    entityPatch.state = opts.serverEntity.state
    setLastConfirmedClientValue(
      key.sourceScope,
      key.repoId,
      key.itemId,
      'state',
      opts.serverEntity.state
    )
  }
  if (opts.serverEntity.autoMergeEnabled !== undefined) {
    entityPatch.autoMergeEnabled = opts.serverEntity.autoMergeEnabled
    setLastConfirmedClientValue(
      key.sourceScope,
      key.repoId,
      key.itemId,
      'autoMerge',
      opts.serverEntity.autoMergeEnabled
    )
  }
  if (opts.serverEntity.assignees) {
    const users = freezeTaskPageGitHubUsers(opts.serverEntity.assignees)
    setConfirmedListSnapshot(key.sourceScope, key.repoId, key.itemId, 'assignees', users)
    entityPatch.assignees = users
  }
  if (opts.serverEntity.reviewRequests) {
    const users = freezeTaskPageGitHubUsers(opts.serverEntity.reviewRequests)
    setConfirmedListSnapshot(key.sourceScope, key.repoId, key.itemId, 'reviewRequests', users)
    entityPatch.reviewRequests = users
  }
  if (Object.keys(entityPatch).length > 0) {
    opts.patchWorkItem(key.itemId, entityPatch, key.repoId, {
      sourceContext: opts.sourceContext
    })
  }
}
export function confirmTaskPageGitHubWorkItemMutation(
  key: TaskPageGitHubMutationKey,
  generation: number,
  opts: {
    query: ParsedTaskQuery
    queryKey: string
    viewerLogin: string | null
    item: GitHubWorkItem
    serverEntity?: Partial<GitHubWorkItem>
    patchWorkItem?: TaskPageGitHubPatchWorkItem
    sourceContext?: TaskSourceContext | null
    scheduleQuiet?: boolean
  }
): 'confirmed' | 'stale' {
  const pending = getPendingTaskPageGitHubOp(key)
  if (!pending || pending.generation !== generation) {
    return 'stale'
  }
  const { skipMeQualifiers, listOp, next } = pending
  if (listOp && !pending.settleAccepted) {
    const snapshot =
      getConfirmedListSnapshot(key.sourceScope, key.repoId, key.itemId, listOp.family) ??
      freezeTaskPageGitHubUsers(
        listOp.family === 'assignees'
          ? (opts.item.assignees ?? [])
          : (opts.item.reviewRequests ?? [])
      )
    // Confirm list ops into snapshots immediately; lastConfirmedClientValue stores scalar authority only.
    const applied = applyTaskPageGitHubListOps(snapshot, [listOp])
    setConfirmedListSnapshot(key.sourceScope, key.repoId, key.itemId, listOp.family, applied)
  } else {
    if (next.state !== undefined && !pending.settleAccepted) {
      setLastConfirmedClientValue(key.sourceScope, key.repoId, key.itemId, 'state', next.state)
    }
    if (next.autoMergeEnabled !== undefined) {
      setLastConfirmedClientValue(
        key.sourceScope,
        key.repoId,
        key.itemId,
        'autoMerge',
        next.autoMergeEnabled
      )
    }
  }
  deletePendingTaskPageGitHubOp(key)
  const item = pending.settleAccepted?.(true) ?? opts.item
  if (!pending.settleAccepted) {
    applyServerEntityIfPresent(key, opts)
  }
  const remaining = listPendingTaskPageGitHubOpsForItem(key.repoId, key.itemId, key.sourceScope)
  const merged = getRegistryMergedTaskPageGitHubWorkItem(item, key.sourceScope)
  // A record-owned edit already published every surviving operation; re-patching would write a stale list.
  if (opts.patchWorkItem && !pending.settleAccepted && remaining.some((op) => op.listOp)) {
    opts.patchWorkItem(
      key.itemId,
      { assignees: merged.assignees, reviewRequests: merged.reviewRequests },
      key.repoId,
      { sourceContext: opts.sourceContext }
    )
  }
  if (isTaskPageGitHubMutationQueryKeyCurrent(opts.queryKey)) {
    recomputeSoftHideForItem({
      item: { ...item, ...merged },
      sourceScope: key.sourceScope,
      query: opts.query,
      queryKey: opts.queryKey,
      viewerLogin: opts.viewerLogin,
      skipMeQualifiers,
      updateSticky: true
    })
  }
  const itemKey = taskPageGitHubItemKey(key.repoId, key.itemId)
  markTaskPageGitHubFamiliesDirty(
    getTaskPageGitHubMutationQueryKey() ?? opts.queryKey,
    itemKey,
    familiesFromPendingOp(pending)
  )
  notifyTaskPageGitHubMutationRegistry()
  return 'confirmed'
}
export function rollbackTaskPageGitHubWorkItemMutation(args: {
  key: TaskPageGitHubMutationKey
  generation: number
  patchWorkItem: TaskPageGitHubPatchWorkItem
  sourceContext?: TaskSourceContext | null
  query: ParsedTaskQuery
  queryKey: string
  viewerLogin: string | null
  item: GitHubWorkItem
}): 'rolled_back' | 'stale' {
  const pending = getPendingTaskPageGitHubOp(args.key)
  if (!pending || pending.generation !== args.generation) {
    return 'stale'
  }
  const { skipMeQualifiers, listOp } = pending
  deletePendingTaskPageGitHubOp(args.key)
  const item = pending.settleAccepted?.(false) ?? args.item
  const merged = getRegistryMergedTaskPageGitHubWorkItem(item, args.key.sourceScope)
  // A record-owned edit never wrote stored copies, so dropping its token is the whole rollback.
  if (!pending.settleAccepted && listOp) {
    args.patchWorkItem(
      args.key.itemId,
      listOp.family === 'assignees'
        ? { assignees: merged.assignees }
        : { reviewRequests: merged.reviewRequests },
      args.key.repoId,
      { sourceContext: args.sourceContext }
    )
  } else if (!pending.settleAccepted) {
    const recomposed = getRegistryMergedTaskPageGitHubWorkItem(
      { ...args.item, ...pending.previous },
      args.key.sourceScope
    )
    args.patchWorkItem(
      args.key.itemId,
      {
        state: recomposed.state,
        autoMergeEnabled: recomposed.autoMergeEnabled
      },
      args.key.repoId,
      { sourceContext: args.sourceContext }
    )
  }
  const after = getRegistryMergedTaskPageGitHubWorkItem(item, args.key.sourceScope)
  if (isTaskPageGitHubMutationQueryKeyCurrent(args.queryKey)) {
    recomputeSoftHideForItem({
      item: { ...item, ...after },
      sourceScope: args.key.sourceScope,
      query: args.query,
      queryKey: args.queryKey,
      viewerLogin: args.viewerLogin,
      skipMeQualifiers,
      updateSticky: true
    })
  }
  notifyTaskPageGitHubMutationRegistry()
  return 'rolled_back'
}
