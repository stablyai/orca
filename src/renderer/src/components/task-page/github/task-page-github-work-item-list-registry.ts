import type { GitHubTaskObservation, ObservedGitHubWorkItem } from '@/lib/github-task-observation'

import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'

import { getTaskSourceCacheScope } from '../../../../../shared/task-source-context'

import { applyTaskPageGitHubListOps } from './task-page-github-work-item-mutation-patches'

import {
  taskPageGitHubMutationItemId,
  taskPageGitHubSnapshotKey,
  serializeTaskPageGitHubMutationKey
} from './task-page-github-work-item-mutation-keys'

import type {
  PendingOp,
  TaskPageGitHubListFamily,
  TaskPageGitHubMutationKey
} from './task-page-github-work-item-registry-types'

import {
  getTaskPageGitHubPendingEntries,
  getPendingTaskPageGitHubOp,
  deletePendingTaskPageGitHubOp,
  publishListRetirements
} from './task-page-github-work-item-mutation-registry'

import {
  listInput,
  completedListInput,
  type ListEntry,
  type ListAddress,
  type ListInput,
  type ListProtection,
  type ListRetirement
} from './task-page-github-work-item-list-model'

const confirmedSnapshots = new Map<string, ListEntry>()
export function getTaskPageGitHubListEntries(): ReadonlyMap<string, ListEntry> {
  return confirmedSnapshots
}
export function clearTaskPageGitHubListEntries(): void {
  confirmedSnapshots.clear()
}
function snapshotKey(
  sourceScope: string | null,
  repoId: string,
  itemId: string,
  family: TaskPageGitHubListFamily,
  observation?: GitHubTaskObservation,
  itemType: GitHubWorkItem['type'] = 'issue'
): string {
  const raw = taskPageGitHubSnapshotKey(sourceScope, repoId, itemId, family)
  return itemType === 'issue' && observation ? JSON.stringify([raw, observation.key]) : raw
}
export function getListEntry(address: ListAddress): ListEntry | undefined {
  const { sourceScope, repoId, itemId, family, observation, itemType } = address
  const entry = confirmedSnapshots.get(
    snapshotKey(sourceScope, repoId, itemId, family, observation, itemType)
  )
  return entry?.observation?.key === observation?.key ? entry : undefined
}
export function beginListEntry(
  address: ListAddress,
  input: ListInput,
  addressed = false
): ListEntry {
  const existing = getListEntry(address)
  if (existing) {
    return existing
  }
  const entry: ListEntry = {
    ...address,
    itemType: address.itemType ?? 'issue',
    lifetime: {},
    base: input,
    protection:
      input.kind === 'full' && !addressed
        ? { kind: 'whole', expectedUsers: input.users, confirmed: false }
        : { kind: 'addressed', facts: new Map() }
  }
  confirmedSnapshots.set(
    snapshotKey(
      address.sourceScope,
      address.repoId,
      address.itemId,
      address.family,
      address.observation,
      address.itemType
    ),
    entry
  )
  return entry
}
export function observeExistingListBase(
  address: ListAddress,
  input: ListInput,
  fillOnly = false
): void {
  const entry = getListEntry(address)
  if (!entry || input.kind !== 'full' || (fillOnly && entry.base.kind === 'full')) {
    return
  }
  if (entry.base.origin === input.origin && entry.base.users === input.users) {
    return
  }
  const updated = { ...entry, base: input }
  confirmedSnapshots.set(
    snapshotKey(
      address.sourceScope,
      address.repoId,
      address.itemId,
      address.family,
      address.observation,
      address.itemType
    ),
    updated
  )
}
export function observeExistingListBases(
  items: readonly ObservedGitHubWorkItem[],
  fillOnly = false
): void {
  for (const item of items) {
    const observation = item.githubObservation
    if (!observation) {
      continue
    }
    for (const family of ['assignees', 'reviewRequests'] as const) {
      observeExistingListBase(
        {
          sourceScope: getTaskSourceCacheScope(observation.source),
          repoId: item.repoId,
          itemId: taskPageGitHubMutationItemId(item),
          itemType: item.type,
          observation,
          family
        },
        listInput(item, family, observation),
        fillOnly
      )
    }
  }
}
export function confirmListOperation(
  key: TaskPageGitHubMutationKey,
  generation: number,
  input: ListInput
): boolean {
  const pending = getPendingTaskPageGitHubOp(key)
  if (!pending?.listOp || pending.generation !== generation) {
    return false
  }
  const address = { ...key, family: pending.listOp.family }
  const occupied = confirmedSnapshots.get(
    snapshotKey(
      key.sourceScope,
      key.repoId,
      key.itemId,
      address.family,
      key.observation,
      key.itemType
    )
  )
  if (occupied && occupied.observation?.key !== key.observation?.key) {
    deletePendingTaskPageGitHubOp(key)
    return true
  }
  const entry = beginListEntry(address, input, true)
  let protection: ListProtection
  if (entry.protection.kind === 'whole') {
    protection = {
      kind: 'whole',
      expectedUsers: applyTaskPageGitHubListOps(entry.protection.expectedUsers, [pending.listOp]),
      confirmed: true
    }
  } else {
    const facts = new Map(entry.protection.facts)
    pending.listOp.logins.forEach((login, index) =>
      facts.set(login, {
        user:
          pending.listOp?.kind === 'add'
            ? (pending.listOp.users?.[index] ?? { login, name: null, avatarUrl: '' })
            : undefined,
        key: serializeTaskPageGitHubMutationKey(key),
        generation
      })
    )
    protection = { kind: 'addressed', facts }
  }
  confirmedSnapshots.set(
    snapshotKey(
      key.sourceScope,
      key.repoId,
      key.itemId,
      address.family,
      key.observation,
      key.itemType
    ),
    { ...entry, protection }
  )
  deletePendingTaskPageGitHubOp(key)
  return true
}
function pendingListEntriesBySlot(): Map<string, PendingOp[]> {
  const groups = new Map<string, PendingOp[]>()
  for (const op of getTaskPageGitHubPendingEntries().values()) {
    if (!op.listOp) {
      continue
    }
    const key = snapshotKey(
      op.key.sourceScope,
      op.key.repoId,
      op.key.itemId,
      op.listOp.family,
      op.key.observation,
      op.key.itemType
    )
    const group = groups.get(key) ?? []
    group.push(op)
    groups.set(key, group)
  }
  return groups
}
export function createListEntryRetirement() {
  const pending = pendingListEntriesBySlot()
  return (entry: ListEntry, input?: ListInput) => retireListEntry(entry, input, pending)
}
export function retireListEntry(
  expected: ListEntry,
  present?: ListInput,
  pending = pendingListEntriesBySlot()
): ListRetirement | undefined {
  const key = snapshotKey(
    expected.sourceScope,
    expected.repoId,
    expected.itemId,
    expected.family,
    expected.observation,
    expected.itemType
  )
  if (confirmedSnapshots.get(key) !== expected) {
    return
  }
  const survivors = pending
    .get(key)
    ?.some((op) => op.key.observation?.key === expected.observation?.key)
  const base = present ?? completedListInput(expected) ?? expected.base
  const { sourceScope, repoId, itemId, itemType, family, observation } = expected
  const address = { sourceScope, repoId, itemId, itemType, family, observation }
  confirmedSnapshots.delete(key)
  const renewal = survivors
    ? beginListEntry(
        address,
        present?.kind === 'full'
          ? present
          : {
              kind: 'display',
              users: base.users.map((user) => ({ ...user })),
              origin: base.origin ? { ...base.origin, completeFamily: undefined } : undefined
            },
        true
      )
    : undefined
  return {
    address,
    fromLifetime: expected.lifetime,
    restoration: base,
    toLifetime: renewal?.lifetime
  }
}
export function deleteConfirmedListSnapshot(
  sourceScope: string | null,
  repoId: string,
  itemId: string,
  family: TaskPageGitHubListFamily,
  observation?: GitHubTaskObservation,
  itemType: GitHubWorkItem['type'] = 'issue',
  retire = createListEntryRetirement(),
  input?: ListInput
): ListRetirement | undefined {
  const entry = getListEntry({ sourceScope, repoId, itemId, family, observation, itemType })
  const retirement = entry && retire(entry, input)
  if (retirement) {
    publishListRetirements([retirement])
  }
  return retirement
}
