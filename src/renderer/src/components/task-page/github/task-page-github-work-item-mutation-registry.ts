import {
  publishListRetirements as publishBatchedListRetirements,
  batchTaskPageGitHubMutationRegistry as batchMutationRegistryNotifications,
  clearTaskPageGitHubMutationRegistryListenersForTests,
  notifyTaskPageGitHubMutationRegistry
} from './task-page-github-mutation-notifications'
export {
  notifyTaskPageGitHubMutationRegistry,
  subscribeTaskPageGitHubMutationRegistry
} from './task-page-github-mutation-notifications'

import {
  getTaskPageGitHubListEntries,
  clearTaskPageGitHubListEntries,
  createListEntryRetirement,
  deleteConfirmedListSnapshot
} from './task-page-github-work-item-list-registry'

import type { ListRetirement, ListQueryTransition } from './task-page-github-work-item-list-model'

export type {
  ListInput,
  ListProtection,
  ListEntry,
  ListAddress,
  ListRetirement,
  ListComposition,
  ListQueryTransition
} from './task-page-github-work-item-list-model'
export {
  listInput,
  completedListClaim,
  matchesListClaim
} from './task-page-github-work-item-list-model'
export {
  getTaskPageGitHubListEntries,
  getListEntry,
  beginListEntry,
  observeExistingListBase,
  observeExistingListBases,
  confirmListOperation,
  createListEntryRetirement,
  retireListEntry,
  deleteConfirmedListSnapshot
} from './task-page-github-work-item-list-registry'
import { markGitHubTaskListRetirements } from '@/store/github/request-coordination'

import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'

import {
  clearLastConfirmedClientValues,
  deleteLastConfirmedClientValue,
  getLastConfirmedClientEntry,
  setLastConfirmedClientValue as storeLastConfirmedClientValue
} from './task-page-github-confirmed-client-values'

import type { GitHubOwnerRepo } from '../../../../../shared/github/pull-request-types'

import type { GitHubTaskObservation } from '@/lib/github-task-observation'

import type {
  PendingOp,
  TaskPageGitHubMembershipBasis,
  TaskPageGitHubMutationKey
} from './task-page-github-work-item-registry-types'

import {
  serializeTaskPageGitHubMutationKey,
  taskPageGitHubOwnedItemKey
} from './task-page-github-work-item-mutation-keys'

import { clearTaskPageGitHubQuietStates } from './task-page-github-work-item-quiet-state'

const pendingByKey = new Map<string, PendingOp>()
const generations = new Map<string, number>()
const membershipBases = new Map<string, TaskPageGitHubMembershipBasis>()
let mutationQueryKey: string | null = null
let activationKey: string | null = null

export function publishListRetirements(retirements: readonly ListRetirement[]): void {
  publishBatchedListRetirements(retirements, markGitHubTaskListRetirements)
}
export function batchTaskPageGitHubMutationRegistry<T>(operation: () => T): T {
  return batchMutationRegistryNotifications(operation, markGitHubTaskListRetirements)
}
export function getTaskPageGitHubPendingEntries(): ReadonlyMap<string, PendingOp> {
  return pendingByKey
}
export function getTaskPageGitHubMembershipBases(): ReadonlyMap<
  string,
  TaskPageGitHubMembershipBasis
> {
  return membershipBases
}
export function membershipBasisKey(
  basis: Pick<
    TaskPageGitHubMembershipBasis,
    'sourceScope' | 'repoId' | 'itemId' | 'rawItemId' | 'observation'
  >
): string {
  return JSON.stringify([
    taskPageGitHubOwnedItemKey(
      basis.sourceScope,
      basis.repoId,
      basis.itemId,
      basis.observation?.key
    ),
    basis.rawItemId
  ])
}
export function setTaskPageGitHubMembershipBasis(basis: TaskPageGitHubMembershipBasis): void {
  if (basis.queryKey === mutationQueryKey) {
    membershipBases.set(membershipBasisKey(basis), basis)
  }
}
export function deleteTaskPageGitHubMembershipBasis(key: string): void {
  membershipBases.delete(key)
}
export function clearTaskPageGitHubConfirmedAuthority(): void {
  clearTaskPageGitHubListEntries()
  clearLastConfirmedClientValues()
}
function setTaskPageGitHubMutationQueryKeyNow(
  queryKey: string,
  transition?: ListQueryTransition
): void {
  if (mutationQueryKey === queryKey) {
    return
  }
  mutationQueryKey = queryKey
  activationKey = null
  membershipBases.clear()
  const entries = [...getTaskPageGitHubListEntries().values()]
  const inputs = transition?.resolve?.(entries)
  const retire = createListEntryRetirement()
  const plans = entries.flatMap((entry) => {
    const input = inputs?.get(entry)
    const retirement = retire(entry, input)
    return retirement ? [{ address: retirement.address, retirement }] : []
  })
  clearLastConfirmedClientValues()
  clearTaskPageGitHubQuietStates()
  for (const serialized of generations.keys()) {
    if (!pendingByKey.has(serialized)) {
      generations.delete(serialized)
    }
  }
  publishListRetirements(plans.flatMap((plan) => (plan.retirement ? [plan.retirement] : [])))
  transition?.publish(plans)
  notifyTaskPageGitHubMutationRegistry()
}
export function setTaskPageGitHubMembershipActivation(key: string): void {
  if (activationKey === key) {
    return
  }
  activationKey = key
  membershipBases.clear()
  clearTaskPageGitHubQuietStates()
  notifyTaskPageGitHubMutationRegistry()
}
export function isTaskPageGitHubMutationQueryKeyCurrent(queryKey: string): boolean {
  return mutationQueryKey === queryKey
}
export function getTaskPageGitHubMutationQueryKey(): string | null {
  return mutationQueryKey
}
export function getPendingTaskPageGitHubOp(key: TaskPageGitHubMutationKey): PendingOp | undefined {
  return pendingByKey.get(serializeTaskPageGitHubMutationKey(key))
}
export function nextTaskPageGitHubMutationGeneration(key: TaskPageGitHubMutationKey): number {
  const serialized = serializeTaskPageGitHubMutationKey(key)
  const next = (generations.get(serialized) ?? 0) + 1
  generations.set(serialized, next)
  return next
}
export function setPendingTaskPageGitHubOp(op: PendingOp): void {
  pendingByKey.set(serializeTaskPageGitHubMutationKey(op.key), op)
}
export function deletePendingTaskPageGitHubOp(
  key: TaskPageGitHubMutationKey
): PendingOp | undefined {
  const serialized = serializeTaskPageGitHubMutationKey(key)
  const existing = pendingByKey.get(serialized)
  pendingByKey.delete(serialized)
  return existing
}
export function listPendingTaskPageGitHubOpsForItem(
  repoId: string,
  itemId: string,
  sourceScope: string | null,
  observation?: GitHubTaskObservation
): PendingOp[] {
  return [...pendingByKey.values()]
    .filter(
      (op) =>
        op.key.repoId === repoId &&
        op.key.itemId === itemId &&
        op.key.sourceScope === sourceScope &&
        op.key.observation?.key === observation?.key
    )
    .sort((a, b) => a.startedAt - b.startedAt)
}
export function hasPendingTaskPageGitHubOpsForItem(
  repoId: string,
  itemId: string,
  sourceScope: string | null,
  observation?: GitHubTaskObservation
): boolean {
  return listPendingTaskPageGitHubOpsForItem(repoId, itemId, sourceScope, observation).length > 0
}
export function setLastConfirmedClientValue(
  sourceScope: string | null,
  repoId: string,
  itemId: string,
  family: string,
  value: unknown,
  ownerRepo?: GitHubOwnerRepo | null,
  observation?: GitHubTaskObservation
): void {
  storeLastConfirmedClientValue(sourceScope, repoId, itemId, family, value, ownerRepo, observation)
}

export function clearConfirmedAuthorityForItem(
  repoId: string,
  itemId: string,
  sourceScope: string | null,
  observation?: GitHubTaskObservation,
  itemType?: GitHubWorkItem['type'],
  retire = createListEntryRetirement()
): void {
  for (const family of ['assignees', 'reviewRequests'] as const) {
    deleteConfirmedListSnapshot(sourceScope, repoId, itemId, family, observation, itemType, retire)
  }
  for (const family of ['state', 'autoMerge']) {
    const entry = getLastConfirmedClientEntry(sourceScope, repoId, itemId, family)
    if (entry?.observation?.key === observation?.key) {
      deleteLastConfirmedClientValue(sourceScope, repoId, itemId, family)
    }
  }
}
export function resetTaskPageGitHubMutationRegistryForTests(): void {
  pendingByKey.clear()
  generations.clear()
  clearTaskPageGitHubListEntries()
  membershipBases.clear()
  clearLastConfirmedClientValues()
  clearTaskPageGitHubQuietStates()
  mutationQueryKey = null
  activationKey = null
  clearTaskPageGitHubMutationRegistryListenersForTests()
}

export function setTaskPageGitHubMutationQueryKey(
  queryKey: string,
  transition?: ListQueryTransition
): void {
  batchTaskPageGitHubMutationRegistry(() =>
    setTaskPageGitHubMutationQueryKeyNow(queryKey, transition)
  )
}

export type { TaskPageGitHubAuthority } from './task-page-github-work-item-authority-read'
export {
  getTaskPageGitHubConfirmedAuthorities,
  getTaskPageGitHubMutationSnapshot,
  getTaskPageGitHubPendingOwnerKeys
} from './task-page-github-work-item-authority-read'

export { getConfirmedListSnapshot } from './task-page-github-work-item-authority-read'
