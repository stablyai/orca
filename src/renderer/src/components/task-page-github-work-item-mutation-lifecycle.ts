import type { ParsedTaskQuery } from '../../../shared/task-query'
import type { GitHubWorkItem } from '../../../shared/types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
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
  markTaskPageGitHubFamiliesDirty,
  isTaskPageGitHubMutationQueryKeyCurrent,
  taskPageGitHubItemKey,
  type TaskPageGitHubMutationKey
} from './task-page-github-work-item-mutation-registry'
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
  // K20: capture before delete.
  const { skipMeQualifiers, listOp, next } = pending
  if (listOp) {
    const snapshot =
      getConfirmedListSnapshot(key.sourceScope, key.repoId, key.itemId, listOp.family) ??
      freezeTaskPageGitHubUsers(
        listOp.family === 'assignees'
          ? (opts.item.assignees ?? [])
          : (opts.item.reviewRequests ?? [])
      )
    // K10: apply confirmed op into snapshot immediately. List authority lives in
    // confirmedSnapshots; lastConfirmedClientValue is scalar-only (state/autoMerge).
    const applied = applyTaskPageGitHubListOps(snapshot, [listOp])
    setConfirmedListSnapshot(key.sourceScope, key.repoId, key.itemId, listOp.family, applied)
  } else {
    if (next.state !== undefined) {
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
  applyServerEntityIfPresent(key, opts)
  const remaining = listPendingTaskPageGitHubOpsForItem(key.repoId, key.itemId, key.sourceScope)
  const merged = getRegistryMergedTaskPageGitHubWorkItem(opts.item, key.sourceScope)
  if (opts.patchWorkItem && remaining.some((op) => op.listOp)) {
    opts.patchWorkItem(
      key.itemId,
      { assignees: merged.assignees, reviewRequests: merged.reviewRequests },
      key.repoId,
      { sourceContext: opts.sourceContext }
    )
  }
  if (isTaskPageGitHubMutationQueryKeyCurrent(opts.queryKey)) {
    recomputeSoftHideForItem({
      item: { ...opts.item, ...merged },
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
  const merged = getRegistryMergedTaskPageGitHubWorkItem(args.item, args.key.sourceScope)
  if (listOp) {
    args.patchWorkItem(
      args.key.itemId,
      listOp.family === 'assignees'
        ? { assignees: merged.assignees }
        : { reviewRequests: merged.reviewRequests },
      args.key.repoId,
      { sourceContext: args.sourceContext }
    )
  } else {
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
  const after = getRegistryMergedTaskPageGitHubWorkItem(args.item, args.key.sourceScope)
  if (isTaskPageGitHubMutationQueryKeyCurrent(args.queryKey)) {
    recomputeSoftHideForItem({
      item: { ...args.item, ...after },
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
