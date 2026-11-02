import {
  clearLastConfirmedClientValues,
  deleteLastConfirmedClientValue,
  getLastConfirmedClientValue,
  setLastConfirmedClientValue as storeLastConfirmedClientValue
} from './task-page-github-confirmed-client-values'
import type {
  GitHubAssignableUser,
  GitHubOwnerRepo
} from '../../../../../shared/github/pull-request-types'
import type {
  PendingOp,
  StickyHideEntry,
  TaskPageGitHubListFamily,
  TaskPageGitHubMutationKey
} from './task-page-github-work-item-registry-types'
import {
  serializeTaskPageGitHubMutationKey,
  taskPageGitHubItemKey,
  taskPageGitHubSnapshotKey
} from './task-page-github-work-item-mutation-keys'
import { clearTaskPageGitHubQuietStates } from './task-page-github-work-item-quiet-state'
type Listener = () => void
const listeners = new Set<Listener>()
const pendingByKey = new Map<string, PendingOp>()
const generations = new Map<string, number>()
const confirmedSnapshots = new Map<string, GitHubAssignableUser[]>()
/** Remember source scope after pending clears so overlays can still resolve confirmed authority. */
const itemSourceScopeByItemKey = new Map<string, string | null>()
const stickyHideByItemKey = new Map<string, StickyHideEntry>()
const softHiddenItemKeys = new Set<string>()
let mutationQueryKey: string | null = null
export function subscribeTaskPageGitHubMutationRegistry(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function notifyTaskPageGitHubMutationRegistry(): void {
  for (const listener of listeners) {
    listener()
  }
}
export function getTaskPageGitHubSoftHiddenItemKeys(): ReadonlySet<string> {
  return softHiddenItemKeys
}
export function getTaskPageGitHubConfirmedAuthorityItemKeys(): ReadonlySet<string> {
  const keys = new Set<string>()
  for (const itemKey of itemSourceScopeByItemKey.keys()) {
    const separator = itemKey.indexOf('\0')
    if (
      separator !== -1 &&
      hasConfirmedAuthorityForItem(itemKey.slice(0, separator), itemKey.slice(separator + 1))
    ) {
      keys.add(itemKey)
    }
  }
  return keys
}
/** Hard refresh drops confirmed authority while retaining in-flight operations. */
export function clearTaskPageGitHubConfirmedAuthority(): void {
  confirmedSnapshots.clear()
  clearLastConfirmedClientValues()
  itemSourceScopeByItemKey.clear()
}
/** Clear query-scoped sticky hides and confirmed authority when the query/repo set changes. */
export function setTaskPageGitHubMutationQueryKey(queryKey: string): void {
  if (mutationQueryKey === queryKey) {
    return
  }
  mutationQueryKey = queryKey
  stickyHideByItemKey.clear()
  softHiddenItemKeys.clear()
  clearTaskPageGitHubConfirmedAuthority()
  // Bound per-query state growth; retain generation counters for live ops so staleness checks remain valid.
  clearTaskPageGitHubQuietStates()
  for (const serialized of generations.keys()) {
    if (!pendingByKey.has(serialized)) {
      generations.delete(serialized)
    }
  }
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
  const serialized = serializeTaskPageGitHubMutationKey(op.key)
  // Whole-field supersession abandons old pending values without rollback; list ops share entries only for matching per-login/batch keys.
  pendingByKey.set(serialized, op)
  rememberItemSourceScope(op.key.repoId, op.key.itemId, op.key.sourceScope)
}

export function rememberItemSourceScope(
  repoId: string,
  itemId: string,
  sourceScope: string | null
): void {
  itemSourceScopeByItemKey.set(taskPageGitHubItemKey(repoId, itemId), sourceScope)
}

/** Resolve confirmed authority from live pending scope, then the last remembered begin/confirm scope. */
export function resolveItemSourceScope(repoId: string, itemId: string): string | null {
  const fromPending = getSourceScopeFromPendingOps(repoId, itemId)
  if (fromPending !== undefined) {
    return fromPending
  }
  const remembered = itemSourceScopeByItemKey.get(taskPageGitHubItemKey(repoId, itemId))
  return remembered !== undefined ? remembered : null
}

export function hasConfirmedAuthorityForItem(repoId: string, itemId: string): boolean {
  const sourceScope = resolveItemSourceScope(repoId, itemId)
  return (
    getConfirmedListSnapshot(sourceScope, repoId, itemId, 'assignees') !== undefined ||
    getConfirmedListSnapshot(sourceScope, repoId, itemId, 'reviewRequests') !== undefined ||
    getLastConfirmedClientValue(sourceScope, repoId, itemId, 'state') !== undefined ||
    getLastConfirmedClientValue(sourceScope, repoId, itemId, 'autoMerge') !== undefined
  )
}
export function deletePendingTaskPageGitHubOp(
  key: TaskPageGitHubMutationKey
): PendingOp | undefined {
  const serialized = serializeTaskPageGitHubMutationKey(key)
  const existing = pendingByKey.get(serialized)
  if (existing) {
    pendingByKey.delete(serialized)
  }
  return existing
}
export function listPendingTaskPageGitHubOpsForItem(
  repoId: string,
  itemId: string,
  sourceScope?: string | null
): PendingOp[] {
  const ops: PendingOp[] = []
  for (const op of pendingByKey.values()) {
    if (op.key.repoId !== repoId || op.key.itemId !== itemId) {
      continue
    }
    if (sourceScope !== undefined && op.key.sourceScope !== sourceScope) {
      continue
    }
    ops.push(op)
  }
  return ops.sort((a, b) => a.startedAt - b.startedAt)
}
export function hasPendingTaskPageGitHubOpsForItem(repoId: string, itemId: string): boolean {
  for (const op of pendingByKey.values()) {
    if (op.key.repoId === repoId && op.key.itemId === itemId) {
      return true
    }
  }
  return false
}
export function getSourceScopeFromPendingOps(
  repoId: string,
  itemId: string
): string | null | undefined {
  for (const op of pendingByKey.values()) {
    if (op.key.repoId === repoId && op.key.itemId === itemId) {
      return op.key.sourceScope
    }
  }
  return undefined
}
export function getConfirmedListSnapshot(
  sourceScope: string | null,
  repoId: string,
  itemId: string,
  family: TaskPageGitHubListFamily
): GitHubAssignableUser[] | undefined {
  return confirmedSnapshots.get(taskPageGitHubSnapshotKey(sourceScope, repoId, itemId, family))
}
export function setConfirmedListSnapshot(
  sourceScope: string | null,
  repoId: string,
  itemId: string,
  family: TaskPageGitHubListFamily,
  users: readonly GitHubAssignableUser[]
): void {
  rememberItemSourceScope(repoId, itemId, sourceScope)
  confirmedSnapshots.set(taskPageGitHubSnapshotKey(sourceScope, repoId, itemId, family), [...users])
}
export function deleteConfirmedListSnapshot(
  sourceScope: string | null,
  repoId: string,
  itemId: string,
  family: TaskPageGitHubListFamily
): void {
  confirmedSnapshots.delete(taskPageGitHubSnapshotKey(sourceScope, repoId, itemId, family))
}
export function setLastConfirmedClientValue(
  sourceScope: string | null,
  repoId: string,
  itemId: string,
  family: string,
  value: unknown,
  ownerRepo?: GitHubOwnerRepo | null
): void {
  rememberItemSourceScope(repoId, itemId, sourceScope)
  storeLastConfirmedClientValue(sourceScope, repoId, itemId, family, value, ownerRepo)
}
export function clearConfirmedAuthorityForItem(repoId: string, itemId: string): void {
  const sourceScope = resolveItemSourceScope(repoId, itemId)
  deleteConfirmedListSnapshot(sourceScope, repoId, itemId, 'assignees')
  deleteConfirmedListSnapshot(sourceScope, repoId, itemId, 'reviewRequests')
  deleteLastConfirmedClientValue(sourceScope, repoId, itemId, 'state')
  deleteLastConfirmedClientValue(sourceScope, repoId, itemId, 'autoMerge')
}
export function getStickyHideEntry(itemKey: string): StickyHideEntry | undefined {
  return stickyHideByItemKey.get(itemKey)
}
export function setStickyHideEntry(entry: StickyHideEntry): void {
  stickyHideByItemKey.set(entry.itemKey, entry)
}
export function deleteStickyHideEntry(itemKey: string): void {
  stickyHideByItemKey.delete(itemKey)
}
export function getAllStickyHideEntries(): ReadonlyMap<string, StickyHideEntry> {
  return stickyHideByItemKey
}
export function setSoftHiddenItemKeys(keys: Iterable<string>): void {
  softHiddenItemKeys.clear()
  for (const key of keys) {
    softHiddenItemKeys.add(key)
  }
}
export function updateSoftHiddenItemKey(itemKey: string, hide: boolean): void {
  if (hide) {
    softHiddenItemKeys.add(itemKey)
  } else {
    softHiddenItemKeys.delete(itemKey)
  }
}
export function gcStickyHidesAbsentFromPages(
  pageItemKeys: ReadonlySet<string>,
  queryKey: string
): void {
  for (const [itemKey, entry] of stickyHideByItemKey) {
    if (entry.queryKey !== queryKey) {
      continue
    }
    if (!pageItemKeys.has(itemKey)) {
      stickyHideByItemKey.delete(itemKey)
      softHiddenItemKeys.delete(itemKey)
    }
  }
}
export function resetTaskPageGitHubMutationRegistryForTests(): void {
  pendingByKey.clear()
  generations.clear()
  confirmedSnapshots.clear()
  clearLastConfirmedClientValues()
  itemSourceScopeByItemKey.clear()
  stickyHideByItemKey.clear()
  softHiddenItemKeys.clear()
  clearTaskPageGitHubQuietStates()
  mutationQueryKey = null
  listeners.clear()
}
