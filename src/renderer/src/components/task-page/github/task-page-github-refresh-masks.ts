import type { GitHubTaskObservation } from '@/lib/github-task-observation'

import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'

import type { TaskSourceContext } from '../../../../../shared/task-source-context'

import { githubTaskSourceKey } from '@/lib/github-task-target'

import { parseGitHubIssueOrPRLink } from '../../../../../shared/github/links'

import { taskPageGitHubMutationItemId } from './task-page-github-work-item-mutation-keys'

import {
  createTaskPageGitHubScalarAuthorityIndex,
  deleteLastConfirmedClientValue
} from './task-page-github-confirmed-client-values'

import {
  createListEntryRetirement,
  listInput,
  getTaskPageGitHubMutationQueryKey,
  batchTaskPageGitHubMutationRegistry,
  getListEntry,
  completedListClaim,
  matchesListClaim,
  deleteConfirmedListSnapshot,
  notifyTaskPageGitHubMutationRegistry
} from './task-page-github-work-item-mutation-registry'

/** Only the exact completed masks observed before this read may be retired. */
export function captureTaskPageGitHubRefreshMasks(
  item: GitHubWorkItem,
  sources: readonly TaskSourceContext[],
  observations: readonly (GitHubTaskObservation | undefined)[] = []
) {
  const query = getTaskPageGitHubMutationQueryKey()
  const id = taskPageGitHubMutationItemId(item)
  const owner = parseGitHubIssueOrPRLink(item.url)?.slug
  const aliases = [...new Set([item.id, `issue:${item.number}`, item.url])]
  const scalarIndex = createTaskPageGitHubScalarAuthorityIndex()
  const captured = sources.map((source, index) => {
    const scope = githubTaskSourceKey(source)
    return {
      scope,
      observation: observations[index],
      scalars: aliases.map((alias) =>
        scalarIndex({ ...item, id: alias }, scope, observations[index], 'state')
      ),
      list: completedListClaim(
        getListEntry({
          sourceScope: scope,
          repoId: item.repoId,
          itemId: id,
          family: 'assignees',
          observation: observations[index]
        })
      )
    }
  })
  return (
    accepted: Pick<GitHubWorkItem, 'state' | 'assignees'>,
    full?: Parameters<typeof listInput>[0]
  ): boolean =>
    batchTaskPageGitHubMutationRegistry(() => {
      const currentIndex = createTaskPageGitHubScalarAuthorityIndex()
      const entries = captured.map((capture) => ({
        ...capture,
        currentScalars: aliases.map((alias) =>
          currentIndex({ ...item, id: alias }, capture.scope, capture.observation, 'state')
        ),
        currentList: completedListClaim(
          getListEntry({
            sourceScope: capture.scope,
            repoId: item.repoId,
            itemId: id,
            family: 'assignees',
            observation: capture.observation
          })
        )
      }))
      const sameQuery = query === getTaskPageGitHubMutationQueryKey()
      for (const entry of entries) {
        if (
          entry.currentScalars.some(
            (scalar, i) =>
              scalar &&
              scalar.value !== accepted.state &&
              (!sameQuery || scalar !== entry.scalars[i])
          )
        ) {
          return false
        }
        if (
          entry.currentList &&
          accepted.assignees !== undefined &&
          !matchesListClaim(entry.currentList, accepted.assignees ?? []) &&
          (!sameQuery || entry.currentList !== entry.list)
        ) {
          return false
        }
      }
      const retire = createListEntryRetirement()
      for (const entry of entries) {
        for (const scalar of entry.currentScalars) {
          if (scalar && scalar.value !== accepted.state) {
            deleteLastConfirmedClientValue(
              scalar.sourceScope,
              item.repoId,
              scalar.itemId,
              'state',
              owner
            )
          }
        }
        if (
          entry.currentList &&
          accepted.assignees !== undefined &&
          !matchesListClaim(entry.currentList, accepted.assignees ?? [])
        ) {
          deleteConfirmedListSnapshot(
            entry.scope,
            item.repoId,
            id,
            'assignees',
            entry.observation,
            'issue',
            retire,
            full ? listInput(full, 'assignees', entry.observation) : undefined
          )
        }
      }
      notifyTaskPageGitHubMutationRegistry()
      return true
    })
}
