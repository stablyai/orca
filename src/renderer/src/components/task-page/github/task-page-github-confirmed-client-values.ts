import { notifyTaskPageGitHubMutationRegistry } from './task-page-github-mutation-notifications'
import {
  sameGitHubTaskObservation,
  type GitHubTaskObservation
} from '@/lib/github-task-observation'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import { parseGitHubIssueOrPRLink } from '../../../../../shared/github/links'
import type { GitHubOwnerRepo } from '../../../../../shared/github/pull-request-types'
import { githubRepoIdentityKey } from '../../../../../shared/github/repository-identity-key'
import { taskPageGitHubLastConfirmedKey } from './task-page-github-work-item-mutation-keys'

export type ConfirmedClientEntry = {
  sourceScope: string | null
  repoId: string
  itemId: string
  family: string
  value: unknown
  ownerRepo?: GitHubOwnerRepo | null
  observation?: GitHubTaskObservation
}
const lastConfirmedClientValues = new Map<string, ConfirmedClientEntry>()
export function getLastConfirmedClientEntries(): ReadonlyMap<string, ConfirmedClientEntry> {
  return lastConfirmedClientValues
}

export function getLastConfirmedClientEntry(
  sourceScope: string | null,
  repoId: string,
  itemId: string,
  family: string
) {
  return lastConfirmedClientValues.get(
    taskPageGitHubLastConfirmedKey(sourceScope, repoId, itemId, family)
  )
}
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
  ownerRepo?: GitHubOwnerRepo | null,
  observation?: GitHubTaskObservation
): void {
  lastConfirmedClientValues.set(
    taskPageGitHubLastConfirmedKey(sourceScope, repoId, itemId, family),
    { sourceScope, repoId, itemId, family, value, ownerRepo, observation }
  )
  notifyTaskPageGitHubMutationRegistry()
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
  if (
    lastConfirmedClientValues.delete(
      taskPageGitHubLastConfirmedKey(sourceScope, repoId, itemId, family)
    )
  ) {
    notifyTaskPageGitHubMutationRegistry()
  }
}
export function clearLastConfirmedClientValues(): void {
  const changed = lastConfirmedClientValues.size > 0
  lastConfirmedClientValues.clear()
  if (changed) {
    notifyTaskPageGitHubMutationRegistry()
  }
}

export function isTaskPageGitHubScalarApplicable(
  entry: ConfirmedClientEntry,
  item: GitHubWorkItem,
  observation: GitHubTaskObservation | undefined
): boolean {
  const owner = parseGitHubIssueOrPRLink(item.url)?.slug
  return (
    sameGitHubTaskObservation(entry.observation, observation) &&
    entry.value !== undefined &&
    (!entry.ownerRepo ||
      (!!owner && githubRepoIdentityKey(entry.ownerRepo) === githubRepoIdentityKey(owner)))
  )
}

/** Index the actual one-slot entries; aliases affect applicability, never storage or lifetime. */
function captureTaskPageGitHubScalarEntries() {
  const entries = new Map<string, ConfirmedClientEntry>()
  const keyFor = (
    owner: string | undefined,
    scope: string | null,
    repoId: string,
    itemId: string,
    family: string
  ) => JSON.stringify([owner ?? scope, repoId, itemId, family])
  for (const entry of lastConfirmedClientValues.values()) {
    for (const key of entry.observation?.aliases ?? [undefined]) {
      const address = keyFor(key, entry.sourceScope, entry.repoId, entry.itemId, entry.family)
      if (!entries.has(address) || (key === entry.observation?.key && entry.sourceScope !== null)) {
        entries.set(address, entry)
      }
    }
  }
  return (
    item: GitHubWorkItem,
    sourceScope: string | null,
    observation: GitHubTaskObservation | undefined,
    family: string
  ) => entries.get(keyFor(observation?.key, sourceScope, item.repoId, item.id, family))
}

export function captureTaskPageGitHubScalarAuthorityIndex() {
  const captured = captureTaskPageGitHubScalarEntries()
  return (...args: Parameters<typeof captured>) => {
    const entry = captured(...args)
    return entry && isTaskPageGitHubScalarApplicable(entry, args[0], args[2]) ? entry : undefined
  }
}

export function createTaskPageGitHubScalarAuthorityIndex() {
  const captured = captureTaskPageGitHubScalarEntries()
  return (...args: Parameters<typeof captured>) => {
    const entry = captured(...args)
    return entry &&
      sameGitHubTaskObservation(entry.observation, args[2]) &&
      getLastConfirmedClientValue(
        entry.sourceScope,
        entry.repoId,
        entry.itemId,
        entry.family,
        parseGitHubIssueOrPRLink(args[0].url)?.slug ?? null
      ) !== undefined
      ? entry
      : undefined
  }
}
