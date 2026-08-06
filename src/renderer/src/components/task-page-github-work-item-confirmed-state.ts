import type { GitHubAssignableUser } from '../../../shared/types'
import type { TaskPageGitHubListFamily } from './task-page-github-work-item-registry-types'
import {
  taskPageGitHubItemKey,
  taskPageGitHubLastConfirmedKey,
  taskPageGitHubSnapshotKey
} from './task-page-github-work-item-mutation-keys'

const confirmedSnapshots = new Map<string, GitHubAssignableUser[]>()
const lastConfirmedClientValues = new Map<string, unknown>()
const itemSourceScopeByItemKey = new Map<string, string | null>()

export function rememberItemSourceScope(itemKey: string, sourceScope: string | null): void {
  itemSourceScopeByItemKey.set(itemKey, sourceScope)
}

export function getRememberedItemSourceScope(itemKey: string): string | null | undefined {
  return itemSourceScopeByItemKey.get(itemKey)
}

export function getRememberedItemKeys(): IterableIterator<string> {
  return itemSourceScopeByItemKey.keys()
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
  users: readonly GitHubAssignableUser[],
  itemKey = taskPageGitHubItemKey(repoId, itemId)
): void {
  rememberItemSourceScope(itemKey, sourceScope)
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

export function getLastConfirmedClientValue(
  sourceScope: string | null,
  repoId: string,
  itemId: string,
  family: string
): unknown {
  return lastConfirmedClientValues.get(
    taskPageGitHubLastConfirmedKey(sourceScope, repoId, itemId, family)
  )
}

export function setLastConfirmedClientValue(
  sourceScope: string | null,
  repoId: string,
  itemId: string,
  family: string,
  value: unknown,
  itemKey = taskPageGitHubItemKey(repoId, itemId)
): void {
  rememberItemSourceScope(itemKey, sourceScope)
  lastConfirmedClientValues.set(
    taskPageGitHubLastConfirmedKey(sourceScope, repoId, itemId, family),
    value
  )
}

export function deleteLastConfirmedClientValue(
  sourceScope: string | null,
  repoId: string,
  itemId: string,
  family: string
): void {
  lastConfirmedClientValues.delete(
    taskPageGitHubLastConfirmedKey(sourceScope, repoId, itemId, family)
  )
}

export function clearTaskPageGitHubConfirmedState(): void {
  confirmedSnapshots.clear()
  lastConfirmedClientValues.clear()
  itemSourceScopeByItemKey.clear()
}
