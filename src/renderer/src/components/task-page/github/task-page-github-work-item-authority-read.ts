import { getListEntry } from './task-page-github-work-item-list-registry'

import { completedListInput } from './task-page-github-work-item-list-model'

import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'

import type { TaskPageGitHubListFamily } from './task-page-github-work-item-registry-types'

import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'

import { githubTaskSourceKey } from '@/lib/github-task-target'

import { getLastConfirmedClientEntries } from './task-page-github-confirmed-client-values'

import type { GitHubTaskObservation } from '@/lib/github-task-observation'

import { taskPageGitHubOwnedItemKey } from './task-page-github-work-item-mutation-keys'

import {
  getTaskPageGitHubPendingEntries,
  getTaskPageGitHubListEntries,
  getTaskPageGitHubMembershipBases,
  completedListClaim
} from './task-page-github-work-item-mutation-registry'

export type TaskPageGitHubAuthority = {
  sourceScope: string | null
  repoId: string
  itemId: string
  observation?: GitHubTaskObservation
  itemType?: GitHubWorkItem['type']
  families: string[]
}
export function getTaskPageGitHubConfirmedAuthorities(): TaskPageGitHubAuthority[] {
  const records = new Map<string, TaskPageGitHubAuthority>()
  for (const entry of [
    ...getTaskPageGitHubListEntries().values(),
    ...getLastConfirmedClientEntries().values()
  ]) {
    if ('protection' in entry && !completedListClaim(entry)) {
      continue
    }
    const key = taskPageGitHubOwnedItemKey(
      entry.sourceScope,
      entry.repoId,
      entry.itemId,
      entry.observation?.key
    )
    const record = records.get(key)
    if (record) {
      record.families.push(entry.family)
    } else {
      records.set(key, {
        sourceScope: entry.sourceScope,
        repoId: entry.repoId,
        itemId: entry.itemId,
        observation: entry.observation,
        itemType: 'itemType' in entry ? entry.itemType : undefined,
        families: [entry.family]
      })
    }
  }
  return [...records.values()]
}
export function getTaskPageGitHubMutationSnapshot(
  owners: readonly GitHubTaskObservation[]
): readonly unknown[] {
  const keys = new Set(owners.flatMap((owner) => owner.aliases))
  const scopes = new Set(
    owners.map((owner) =>
      owner.source && owner.source.provider === 'github' ? githubTaskSourceKey(owner.source) : null
    )
  )
  const repoIds = new Set(owners.map((owner) => owner.repoId))
  const relevant = (entry: {
    repoId: string
    sourceScope: string | null
    observation?: GitHubTaskObservation
  }) =>
    entry.observation
      ? keys.has(entry.observation.key)
      : repoIds.has(entry.repoId) && (entry.sourceScope === null || scopes.has(entry.sourceScope))
  return [
    ...[...getTaskPageGitHubPendingEntries().values()].filter((op) => relevant(op.key)),
    ...[...getTaskPageGitHubListEntries().values()].filter(relevant),
    ...[...getLastConfirmedClientEntries().values()].filter(relevant),
    ...[...getTaskPageGitHubMembershipBases().values()].filter(relevant)
  ]
}
export function getTaskPageGitHubPendingOwnerKeys(): ReadonlySet<string> {
  return new Set(
    [...getTaskPageGitHubPendingEntries().values()].map(({ key }) =>
      taskPageGitHubOwnedItemKey(key.sourceScope, key.repoId, key.itemId, key.observation?.key)
    )
  )
}
export function getConfirmedListSnapshot(
  sourceScope: string | null,
  repoId: string,
  itemId: string,
  family: TaskPageGitHubListFamily,
  observation?: GitHubTaskObservation,
  itemType?: GitHubWorkItem['type']
): GitHubAssignableUser[] | undefined {
  const entry = getListEntry({ sourceScope, repoId, itemId, family, observation, itemType })
  return entry?.protection.kind === 'whole' && entry.protection.confirmed
    ? entry.protection.expectedUsers
    : completedListInput(entry)?.users
}
