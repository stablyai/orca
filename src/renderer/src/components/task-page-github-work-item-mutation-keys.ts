import type {
  TaskPageGitHubListFamily,
  TaskPageGitHubMutationKey
} from './task-page-github-work-item-registry-types'

export function taskPageGitHubItemKey(repoId: string, itemId: string): string {
  return `${repoId}\0${itemId}`
}
export function serializeTaskPageGitHubMutationKey(key: TaskPageGitHubMutationKey): string {
  return `${key.sourceScope ?? ''}\0${key.repoId}\0${key.itemId}\0${key.opKey}`
}
export function taskPageGitHubSnapshotKey(
  sourceScope: string | null,
  repoId: string,
  itemId: string,
  family: TaskPageGitHubListFamily
): string {
  return `${sourceScope ?? ''}\0${repoId}\0${itemId}\0${family}`
}
export function taskPageGitHubLastConfirmedKey(
  sourceScope: string | null,
  repoId: string,
  itemId: string,
  family: string
): string {
  return `${sourceScope ?? ''}\0${repoId}\0${itemId}\0${family}`
}
export function taskPageGitHubFamilyDirtyKey(itemKey: string, family: string): string {
  return `${itemKey}\0${family}`
}
export function taskPageGitHubListOpKey(
  family: TaskPageGitHubListFamily,
  logins: readonly string[]
): string {
  const normalized = logins.map((login) => login.toLowerCase()).sort()
  if (normalized.length === 1) {
    return `${family}:${normalized[0]}`
  }
  return `${family}:batch:${normalized.join(',')}`
}
