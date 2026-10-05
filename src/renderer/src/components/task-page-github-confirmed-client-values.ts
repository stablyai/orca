import type { GitHubOwnerRepo } from '../../../shared/github/pull-request-types'
import { githubRepoIdentityKey } from '../../../shared/github/repository-identity-key'
import { taskPageGitHubLastConfirmedKey } from './task-page-github-work-item-mutation-keys'

const lastConfirmedClientValues = new Map<
  string,
  { value: unknown; ownerRepo?: GitHubOwnerRepo | null }
>()

export function getLastConfirmedClientValue(
  sourceScope: string | null,
  repoId: string,
  itemId: string,
  family: string,
  ownerRepo?: GitHubOwnerRepo | null
): unknown {
  const entry = lastConfirmedClientValues.get(
    taskPageGitHubLastConfirmedKey(sourceScope, repoId, itemId, family)
  )
  if (
    ownerRepo !== undefined &&
    entry?.ownerRepo &&
    (!ownerRepo || githubRepoIdentityKey(ownerRepo) !== githubRepoIdentityKey(entry.ownerRepo))
  ) {
    return undefined
  }
  return entry?.value
}
export function setLastConfirmedClientValue(
  sourceScope: string | null,
  repoId: string,
  itemId: string,
  family: string,
  value: unknown,
  ownerRepo?: GitHubOwnerRepo | null
): void {
  lastConfirmedClientValues.set(
    taskPageGitHubLastConfirmedKey(sourceScope, repoId, itemId, family),
    { value, ownerRepo }
  )
}
export function deleteLastConfirmedClientValue(
  sourceScope: string | null,
  repoId: string,
  itemId: string,
  family: string,
  ownerRepo?: GitHubOwnerRepo | null
): void {
  if (
    ownerRepo !== undefined &&
    getLastConfirmedClientValue(sourceScope, repoId, itemId, family, ownerRepo) === undefined
  ) {
    return
  }
  lastConfirmedClientValues.delete(
    taskPageGitHubLastConfirmedKey(sourceScope, repoId, itemId, family)
  )
}
export function clearLastConfirmedClientValues(): void {
  lastConfirmedClientValues.clear()
}
