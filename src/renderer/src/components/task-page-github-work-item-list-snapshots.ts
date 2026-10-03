import type { GitHubAssignableUser } from '../../../shared/github/pull-request-types'
import { taskPageGitHubSnapshotKey } from './task-page-github-work-item-mutation-keys'
import type { TaskPageGitHubListFamily } from './task-page-github-work-item-registry-types'

const snapshots = new Map<string, { users: GitHubAssignableUser[]; confirmed: boolean }>()

export function clearTaskPageGitHubListSnapshots(): void {
  snapshots.clear()
}

export function getConfirmedListSnapshot(
  sourceScope: string | null,
  repoId: string,
  itemId: string,
  family: TaskPageGitHubListFamily
): GitHubAssignableUser[] | undefined {
  return snapshots.get(taskPageGitHubSnapshotKey(sourceScope, repoId, itemId, family))?.users
}

export function writeTaskPageGitHubListSnapshot(
  sourceScope: string | null,
  repoId: string,
  itemId: string,
  family: TaskPageGitHubListFamily,
  users: readonly GitHubAssignableUser[],
  provenance: 'seed' | 'confirmed'
): void {
  snapshots.set(taskPageGitHubSnapshotKey(sourceScope, repoId, itemId, family), {
    users: [...users],
    confirmed: provenance === 'confirmed'
  })
}

export function deleteConfirmedListSnapshot(
  sourceScope: string | null,
  repoId: string,
  itemId: string,
  family: TaskPageGitHubListFamily
): void {
  snapshots.delete(taskPageGitHubSnapshotKey(sourceScope, repoId, itemId, family))
}

/** A successful sibling owns the snapshot even after this edit fails. */
export function deleteUnconfirmedListSnapshot(
  sourceScope: string | null,
  repoId: string,
  itemId: string,
  family: TaskPageGitHubListFamily
): void {
  const key = taskPageGitHubSnapshotKey(sourceScope, repoId, itemId, family)
  if (snapshots.get(key)?.confirmed === false) {
    snapshots.delete(key)
  }
}
