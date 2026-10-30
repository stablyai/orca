import {
  getGitHubTaskObservation,
  gitHubTaskFamilyOrigin,
  type GitHubTaskObservation
} from '@/lib/github-task-observation'

import {
  createTaskPageGitHubAuthorityProjection,
  adoptTaskPageGitHubMembershipFamilies,
  familiesFromPendingOp,
  freezeTaskPageGitHubUsers
} from './task-page-github-work-item-mutation-composition'

import {
  taskPageGitHubMutationItemId,
  taskPageGitHubFamilyDirtyKey,
  taskPageGitHubOwnedItemKey
} from './task-page-github-work-item-mutation-keys'

import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'

import type { TaskSourceContext } from '../../../../../shared/task-source-context'

import { parseGitHubIssueOrPRLink } from '../../../../../shared/github/links'

import {
  type createListEntryRetirement,
  getListEntry,
  listInput,
  completedListClaim,
  matchesListClaim,
  deleteConfirmedListSnapshot
} from './task-page-github-work-item-mutation-registry'

import {
  createTaskPageGitHubScalarAuthorityIndex,
  deleteLastConfirmedClientValue
} from './task-page-github-confirmed-client-values'

import { getOrCreateQuietRevalidateState } from './task-page-github-work-item-quiet-state'

import type { TaskPageGitHubPatchWorkItem } from './task-page-github-work-item-mutation-types'

export const MAX_LAG_TRAILS = 5
export const LAG_WALL_BUDGET_MS = 90_000
export const LAG_BACKOFF_MS = [500, 1000, 2000, 4000, 8000] as const

/** Adopt search field by field without regressing confirmed values; never force-accept lagging data. */
export function adoptQuietSearchFieldsForItem(args: {
  retireListEntry?: ReturnType<typeof createListEntryRetirement>
  scalarFor?: ReturnType<typeof createTaskPageGitHubScalarAuthorityIndex>
  projection?: ReturnType<typeof createTaskPageGitHubAuthorityProjection>
  item: GitHubWorkItem
  serverItem: GitHubWorkItem
  sourceScope: string | null
  observation?: GitHubTaskObservation
  queryKey: string
  fetchStartedAtGeneration: number
  patchWorkItem: TaskPageGitHubPatchWorkItem
  sourceContext?: TaskSourceContext | null
}): { needTrailing: boolean } {
  const state = getOrCreateQuietRevalidateState(args.queryKey)
  const itemId = taskPageGitHubMutationItemId(args.item)
  const observation = args.observation ?? getGitHubTaskObservation(args.serverItem)
  const itemKey = taskPageGitHubOwnedItemKey(
    args.sourceScope,
    args.item.repoId,
    itemId,
    observation?.key
  )
  const ownerRepo = parseGitHubIssueOrPRLink(args.item.url)?.slug ?? null
  const scalarFor = args.scalarFor ?? createTaskPageGitHubScalarAuthorityIndex()
  const scalars = {
    state: scalarFor(args.item, args.sourceScope, observation, 'state'),
    autoMerge: scalarFor(args.item, args.sourceScope, observation, 'autoMerge')
  }
  const pending = (args.projection ?? createTaskPageGitHubAuthorityProjection()).pending(
    args.item,
    args.sourceScope,
    observation
  )
  const pendingFamilies = new Set(pending.flatMap(familiesFromPendingOp))
  let needTrailing = false
  const G0 = args.fetchStartedAtGeneration
  const tryFamily = (
    family: string,
    adopt: () => void,
    matches: () => boolean,
    hasClientAuthority: () => boolean,
    releaseClientAuthority: () => void
  ): void => {
    if (pendingFamilies.has(family)) {
      return
    }
    const scalar = family === 'state' || family === 'autoMerge' ? scalars[family] : undefined
    const familyItemKey =
      family === 'state' || family === 'autoMerge'
        ? taskPageGitHubOwnedItemKey(
            scalar?.sourceScope ?? args.sourceScope,
            args.item.repoId,
            args.item.id,
            scalar?.observation?.key ?? observation?.key
          )
        : itemKey
    const dirtyAt =
      state.familyDirtyAt.get(taskPageGitHubFamilyDirtyKey(familyItemKey, family)) ?? 0
    if (dirtyAt > G0) {
      needTrailing = true
      return
    }
    const hasAuthority = hasClientAuthority()
    if (hasAuthority && !matches()) {
      const lagKey = taskPageGitHubFamilyDirtyKey(familyItemKey, family)
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
    adoptTaskPageGitHubMembershipFamilies(
      args.serverItem,
      args.sourceScope,
      args.queryKey,
      observation,
      [family],
      hasAuthority
    )
    if (hasAuthority) {
      releaseClientAuthority()
    }
    state.lagSkipAttempts.delete(taskPageGitHubFamilyDirtyKey(familyItemKey, family))
  }
  tryFamily(
    'state',
    () => {
      args.patchWorkItem(args.item.id, { state: args.serverItem.state }, args.item.repoId, {
        sourceContext: args.sourceContext,
        observation,
        valueOrigins: {
          state: gitHubTaskFamilyOrigin(args.serverItem, 'state') ?? {
            kind: 'ordinary',
            owner: observation
          }
        },
        ownerRepo
      })
    },
    () => !scalars.state || args.serverItem.state === scalars.state.value,
    () => !!scalars.state,
    () => {
      const entry = scalars.state!
      deleteLastConfirmedClientValue(
        entry.sourceScope,
        entry.repoId,
        entry.itemId,
        'state',
        ownerRepo
      )
    }
  )

  tryFamily(
    'autoMerge',
    () => {
      args.patchWorkItem(
        args.item.id,
        { autoMergeEnabled: args.serverItem.autoMergeEnabled },
        args.item.repoId,
        {
          sourceContext: args.sourceContext,
          ownerRepo,
          observation,
          valueOrigins: {
            autoMerge: gitHubTaskFamilyOrigin(args.serverItem, 'autoMerge') ?? {
              kind: 'ordinary',
              owner: observation
            }
          }
        }
      )
    },
    () => !scalars.autoMerge || args.serverItem.autoMergeEnabled === scalars.autoMerge.value,
    () => !!scalars.autoMerge,
    () => {
      const entry = scalars.autoMerge!
      deleteLastConfirmedClientValue(
        entry.sourceScope,
        entry.repoId,
        entry.itemId,
        'autoMerge',
        ownerRepo
      )
    }
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
          {
            sourceContext: args.sourceContext,
            ownerRepo,
            observation,
            valueOrigins: {
              [family]: gitHubTaskFamilyOrigin(args.serverItem, family) ?? {
                kind: 'ordinary',
                owner: observation
              }
            }
          }
        )
      },
      () => {
        const claim = completedListClaim(
          getListEntry({
            sourceScope: args.sourceScope,
            repoId: args.item.repoId,
            itemId,
            family,
            observation,
            itemType: args.item.type
          })
        )
        return !claim || matchesListClaim(claim, serverListValue)
      },
      () =>
        !!completedListClaim(
          getListEntry({
            sourceScope: args.sourceScope,
            repoId: args.item.repoId,
            itemId,
            family,
            observation,
            itemType: args.item.type
          })
        ),
      () =>
        deleteConfirmedListSnapshot(
          args.sourceScope,
          args.item.repoId,
          itemId,
          family,
          observation,
          args.item.type,
          args.retireListEntry,
          listInput(args.serverItem, family, observation)
        )
    )
  }
  return { needTrailing }
}
