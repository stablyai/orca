import { composeListDestination } from './task-page-github-work-item-list-output'

export {
  dependsOnTaskPageGitHubListRetirement,
  restoreTaskPageGitHubListOutput
} from './task-page-github-work-item-list-output'
import { getTaskSourceCacheScope } from '../../../../../shared/task-source-context'

import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'

import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'

import {
  getTaskPageGitHubPendingEntries,
  getTaskPageGitHubListEntries,
  type ListEntry,
  type ListAddress,
  type ListInput,
  type ListComposition
} from './task-page-github-work-item-mutation-registry'

import { captureTaskPageGitHubScalarAuthorityIndex } from './task-page-github-confirmed-client-values'

import {
  taskPageGitHubMutationItemId,
  taskPageGitHubOwnedItemKey,
  taskPageGitHubLastConfirmedKey,
  serializeTaskPageGitHubMutationKey
} from './task-page-github-work-item-mutation-keys'

import {
  getGitHubTaskObservation,
  patchObservedGitHubWorkItem,
  type GitHubTaskObservation,
  type GitHubTaskFamily,
  type GitHubTaskValueOrigin,
  type ObservedGitHubWorkItem
} from '@/lib/github-task-observation'

import type {
  PendingListOp,
  PendingOp,
  TaskPageGitHubListFamily
} from './task-page-github-work-item-registry-types'

export function freezeTaskPageGitHubUsers(
  users: readonly GitHubAssignableUser[]
): GitHubAssignableUser[] {
  return users.map((user) => ({
    login: user.login,
    name: user.name,
    avatarUrl: user.avatarUrl
  }))
}

export function pendingListOpsForFamily(
  ops: readonly PendingOp[],
  family: TaskPageGitHubListFamily
): PendingListOp[] {
  // Keep the latest op per login so rapid toggles compose to the last intent.
  return [...ops]
    .filter((pending) => pending.listOp?.family === family)
    .sort((a, b) => a.startedAt - b.startedAt)
    .reduce<PendingListOp[]>((acc, pending) => {
      if (!pending.listOp) {
        return acc
      }
      if (pending.listOp.logins.length > 1) {
        acc.push(pending.listOp)
        return acc
      }
      const login = pending.listOp.logins[0]
      const lastIndex = acc.findIndex((op) => op.logins.length === 1 && op.logins[0] === login)
      if (lastIndex !== -1) {
        acc[lastIndex] = pending.listOp
      } else {
        acc.push(pending.listOp)
      }
      return acc
    }, [])
}

export function createTaskPageGitHubAuthorityProjection() {
  const groups = new Map<
    string,
    {
      ops: PendingOp[]
      next: Partial<GitHubWorkItem>
      origins: Partial<Record<GitHubTaskFamily, GitHubTaskValueOrigin>>
      familyOps: Partial<Record<TaskPageGitHubListFamily, PendingListOp[]>>
      lists: Partial<Record<TaskPageGitHubListFamily, ListEntry>>
    }
  >()
  const groupFor = (
    sourceScope: string | null,
    repoId: string,
    itemId: string,
    observation?: GitHubTaskObservation
  ) => {
    const key = taskPageGitHubOwnedItemKey(sourceScope, repoId, itemId, observation?.key)
    let group = groups.get(key)
    if (!group) {
      group = { ops: [], next: {}, origins: {}, familyOps: {}, lists: {} }
      groups.set(key, group)
    }
    return group
  }
  for (const op of getTaskPageGitHubPendingEntries().values()) {
    groupFor(op.key.sourceScope, op.key.repoId, op.key.itemId, op.key.observation).ops.push(op)
  }
  for (const entry of getTaskPageGitHubListEntries().values()) {
    groupFor(entry.sourceScope, entry.repoId, entry.itemId, entry.observation).lists[entry.family] =
      entry
  }
  for (const group of groups.values()) {
    group.ops.sort((a, b) => a.startedAt - b.startedAt)
    for (const op of group.ops) {
      if (op.listOp) {
        continue
      }
      Object.assign(group.next, op.next)
      for (const family of ['state', 'autoMerge'] as const) {
        if ((family === 'state' ? op.next.state : op.next.autoMergeEnabled) !== undefined) {
          group.origins[family] = {
            kind: 'pending',
            owner: op.key.observation,
            coordinate: serializeTaskPageGitHubMutationKey(op.key),
            generation: op.generation
          }
        }
      }
    }
    for (const family of ['assignees', 'reviewRequests'] as const) {
      group.familyOps[family] = pendingListOpsForFamily(group.ops, family)
    }
  }
  const scalarFor = captureTaskPageGitHubScalarAuthorityIndex()
  const compose = (
    item: ObservedGitHubWorkItem,
    sourceScope: string | null,
    observation = getGitHubTaskObservation(item)
  ): ObservedGitHubWorkItem => {
    const itemId = taskPageGitHubMutationItemId(item)
    const coordinate = taskPageGitHubOwnedItemKey(
      sourceScope,
      item.repoId,
      itemId,
      observation?.key
    )
    const group = groups.get(coordinate)
    const origins: Partial<Record<GitHubTaskFamily, GitHubTaskValueOrigin>> = {}
    const patch: Partial<GitHubWorkItem> = {}
    for (const family of ['state', 'autoMerge'] as const) {
      const entry = scalarFor(item, sourceScope, observation, family)
      if (!entry) {
        continue
      }
      const value = entry.value
      if (
        family === 'state' &&
        (value === 'open' || value === 'closed' || value === 'merged' || value === 'draft')
      ) {
        patch.state = value
      }
      if (family === 'autoMerge' && typeof value === 'boolean') {
        patch.autoMergeEnabled = value
      }
      origins[family] = {
        kind: 'scalar',
        owner: entry.observation,
        coordinate: taskPageGitHubLastConfirmedKey(entry.sourceScope, item.repoId, item.id, family)
      }
    }
    Object.assign(patch, group?.next)
    Object.assign(origins, group?.origins)
    let merged = Object.keys(patch).length
      ? patchObservedGitHubWorkItem(item, patch, origins)
      : item
    for (const family of ['assignees', 'reviewRequests'] as const) {
      merged = composeListDestination(
        merged,
        family,
        group?.lists[family],
        group?.familyOps[family] ?? []
      )
    }
    return merged
  }
  return Object.assign(compose, {
    observe: (address: ListAddress, input: ListInput) => {
      const group = groups.get(
        taskPageGitHubOwnedItemKey(
          address.sourceScope,
          address.repoId,
          address.itemId,
          address.observation?.key
        )
      )
      const entry = group?.lists[address.family]
      if (group && entry && input.kind === 'full' && entry.base.kind !== 'full') {
        group.lists[address.family] = { ...entry, base: input }
      }
    },
    list: (item: ObservedGitHubWorkItem, plan: ListComposition) => {
      const { address } = plan
      if (item.repoId !== address.repoId || taskPageGitHubMutationItemId(item) !== address.itemId) {
        return item
      }
      const group = groups.get(
        taskPageGitHubOwnedItemKey(
          address.sourceScope,
          address.repoId,
          address.itemId,
          address.observation?.key
        )
      )
      return composeListDestination(
        item,
        address.family,
        group?.lists[address.family],
        group?.familyOps[address.family] ?? [],
        plan.retirement
      )
    },
    pending: (
      item: GitHubWorkItem,
      sourceScope: string | null,
      observation?: GitHubTaskObservation
    ) =>
      groups.get(
        taskPageGitHubOwnedItemKey(
          sourceScope,
          item.repoId,
          taskPageGitHubMutationItemId(item),
          observation?.key
        )
      )?.ops ?? []
  })
}

export function createTaskPageGitHubListCompositionProgram(plans: readonly ListComposition[]) {
  const byLifetime = new Map<object, ListComposition[]>()
  const byAddress = new Map<string, ListComposition[]>()
  for (const plan of plans) {
    const { address } = plan
    const key =
      taskPageGitHubOwnedItemKey(
        address.sourceScope,
        address.repoId,
        address.itemId,
        address.observation?.key
      ) + address.family
    const group = byAddress.get(key) ?? []
    group.push(plan)
    byAddress.set(key, group)
    if (plan.retirement) {
      byLifetime.set(plan.retirement.fromLifetime, group)
    }
  }
  const projection = createTaskPageGitHubAuthorityProjection()
  return (item: ObservedGitHubWorkItem): ObservedGitHubWorkItem => {
    let result = item
    for (const family of ['assignees', 'reviewRequests'] as const) {
      const origin = item.githubValueOrigins?.[family]
      const owner = origin?.owner ?? getGitHubTaskObservation(item)
      const key =
        taskPageGitHubOwnedItemKey(
          owner ? getTaskSourceCacheScope(owner.source) : null,
          item.repoId,
          taskPageGitHubMutationItemId(item),
          owner?.key
        ) + family
      const group =
        (origin?.listLifetime && byLifetime.get(origin.listLifetime)) || byAddress.get(key)
      for (const plan of group ?? []) {
        result = projection.list(result, plan)
      }
    }
    return result
  }
}

export function getRegistryMergedTaskPageGitHubWorkItem(
  item: GitHubWorkItem,
  sourceScope: string | null,
  observation = getGitHubTaskObservation(item)
): ObservedGitHubWorkItem {
  return createTaskPageGitHubAuthorityProjection()(item, sourceScope, observation)
}

export function familiesFromPendingOp(op: PendingOp): string[] {
  if (op.listOp) {
    return [op.listOp.family]
  }
  if (op.key.opKey === 'merge') {
    return ['state', 'merge', 'autoMerge']
  }
  if (op.key.opKey === 'autoMerge') {
    return ['autoMerge']
  }
  if (op.key.opKey === 'state') {
    return ['state']
  }
  return [op.key.opKey]
}

export {
  establishTaskPageGitHubMembership,
  adoptTaskPageGitHubMembershipFamilies,
  createTaskPageGitHubMembershipProjection
} from './task-page-github-work-item-membership-projection'
