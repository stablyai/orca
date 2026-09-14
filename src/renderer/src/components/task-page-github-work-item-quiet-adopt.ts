import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { loginSetOfUsers, loginSetsEqual } from './task-page-github-work-item-mutation-patches'
import {
  familiesFromPendingOp,
  freezeTaskPageGitHubUsers
} from './task-page-github-work-item-mutation-composition'
import {
  getConfirmedListSnapshot,
  getLastConfirmedClientValue,
  getOrCreateQuietRevalidateState,
  listPendingTaskPageGitHubOpsForItem,
  deleteConfirmedListSnapshot,
  deleteLastConfirmedClientValue,
  taskPageGitHubFamilyDirtyKey,
  taskPageGitHubItemKey
} from './task-page-github-work-item-mutation-registry'
import type { TaskPageGitHubPatchWorkItem } from './task-page-github-work-item-mutation-types'

export const MAX_LAG_TRAILS = 5
export const LAG_WALL_BUDGET_MS = 90_000
export const LAG_BACKOFF_MS = [500, 1000, 2000, 4000, 8000] as const

function hasPendingForFamily(
  sourceScope: string | null,
  repoId: string,
  itemId: string,
  family: string
): boolean {
  for (const op of listPendingTaskPageGitHubOpsForItem(repoId, itemId, sourceScope)) {
    if (op.listOp?.family === family) {
      return true
    }
    if (!op.listOp && familiesFromPendingOp(op).includes(family)) {
      return true
    }
  }
  return false
}

/**
 * Non-regressive field-wise adopt from search (K21). Never force-accept.
 */
export function adoptQuietSearchFieldsForItem(args: {
  item: GitHubWorkItem
  serverItem: GitHubWorkItem
  sourceScope: string | null
  queryKey: string
  fetchStartedAtGeneration: number
  patchWorkItem: TaskPageGitHubPatchWorkItem
  sourceContext?: TaskSourceContext | null
}): { needTrailing: boolean } {
  const state = getOrCreateQuietRevalidateState(args.queryKey)
  const itemKey = taskPageGitHubItemKey(args.item.repoId, args.item.id)
  let needTrailing = false
  const G0 = args.fetchStartedAtGeneration
  const tryFamily = (
    family: string,
    adopt: () => void,
    matches: () => boolean,
    hasClientAuthority: () => boolean,
    releaseClientAuthority: () => void
  ): void => {
    if (hasPendingForFamily(args.sourceScope, args.item.repoId, args.item.id, family)) {
      return
    }
    const dirtyAt = state.familyDirtyAt.get(taskPageGitHubFamilyDirtyKey(itemKey, family)) ?? 0
    if (dirtyAt > G0) {
      needTrailing = true
      return
    }
    const hasAuthority = hasClientAuthority()
    if (hasAuthority && !matches()) {
      const lagKey = taskPageGitHubFamilyDirtyKey(itemKey, family)
      const attempts = (state.lagSkipAttempts.get(lagKey) ?? 0) + 1
      state.lagSkipAttempts.set(lagKey, attempts)
      const wallExceeded = Date.now() - state.lastConfirmAt > LAG_WALL_BUDGET_MS
      if (attempts < MAX_LAG_TRAILS && !wallExceeded) {
        needTrailing = true
      }
      // K21: never force-accept lagging search.
      return
    }
    adopt()
    if (hasAuthority) {
      releaseClientAuthority()
    }
    state.lagSkipAttempts.delete(taskPageGitHubFamilyDirtyKey(itemKey, family))
  }
  tryFamily(
    'state',
    () => {
      args.patchWorkItem(args.item.id, { state: args.serverItem.state }, args.item.repoId, {
        sourceContext: args.sourceContext
      })
    },
    () => {
      const last = getLastConfirmedClientValue(
        args.sourceScope,
        args.item.repoId,
        args.item.id,
        'state'
      )
      return last === undefined || args.serverItem.state === last
    },
    () =>
      getLastConfirmedClientValue(args.sourceScope, args.item.repoId, args.item.id, 'state') !==
      undefined,
    () => deleteLastConfirmedClientValue(args.sourceScope, args.item.repoId, args.item.id, 'state')
  )
  tryFamily(
    'autoMerge',
    () => {
      args.patchWorkItem(
        args.item.id,
        { autoMergeEnabled: args.serverItem.autoMergeEnabled },
        args.item.repoId,
        { sourceContext: args.sourceContext }
      )
    },
    () => {
      const last = getLastConfirmedClientValue(
        args.sourceScope,
        args.item.repoId,
        args.item.id,
        'autoMerge'
      )
      return last === undefined || args.serverItem.autoMergeEnabled === last
    },
    () =>
      getLastConfirmedClientValue(args.sourceScope, args.item.repoId, args.item.id, 'autoMerge') !==
      undefined,
    () =>
      deleteLastConfirmedClientValue(args.sourceScope, args.item.repoId, args.item.id, 'autoMerge')
  )
  for (const family of ['assignees', 'reviewRequests'] as const) {
    const serverListValue =
      family === 'assignees' ? args.serverItem.assignees : args.serverItem.reviewRequests
    if (serverListValue === undefined) {
      continue
    }
    tryFamily(
      family,
      () => {
        const serverList = freezeTaskPageGitHubUsers(serverListValue)
        args.patchWorkItem(
          args.item.id,
          family === 'assignees' ? { assignees: serverList } : { reviewRequests: serverList },
          args.item.repoId,
          { sourceContext: args.sourceContext }
        )
      },
      () => {
        const snapshot = getConfirmedListSnapshot(
          args.sourceScope,
          args.item.repoId,
          args.item.id,
          family
        )
        if (!snapshot) {
          return true
        }
        return loginSetsEqual(loginSetOfUsers(snapshot), loginSetOfUsers(serverListValue))
      },
      () =>
        getConfirmedListSnapshot(args.sourceScope, args.item.repoId, args.item.id, family) !==
        undefined,
      () => deleteConfirmedListSnapshot(args.sourceScope, args.item.repoId, args.item.id, family)
    )
  }
  return { needTrailing }
}
