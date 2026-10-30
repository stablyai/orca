import type { AppState } from '@/store/types'

import { taskPageGitHubOwnedItemKey } from './task-page-github-work-item-mutation-keys'

import {
  listInput,
  getTaskPageGitHubMutationQueryKey,
  setTaskPageGitHubMutationQueryKey,
  type ListEntry,
  type ListInput,
  type ListQueryTransition
} from './task-page-github-work-item-mutation-registry'

import { createTaskPageGitHubListCompositionProgram } from './task-page-github-work-item-mutation-composition'

import { taskPageGitHubMutationItemId } from './task-page-github-work-item-mutation-keys'

import { parseGitHubIssueOrPRLink } from '../../../../../shared/github/links'

import { getTaskPageRepoSourceContext } from '../task-page-source-context'

import { createGitHubTaskObservationIndex } from '@/lib/github-task-observation'

import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'

import { gitHubTaskFamilyOrigin } from '@/lib/github-task-observation'

import type { GitHubWorkItemPatch } from '@/store/github/cache-model'

export function transitionTaskPageGitHubMutationQuery(
  queryKey: string,
  state: Pick<AppState, 'repos' | 'workItemsCache' | 'patchWorkItems'>,
  pages: readonly (GitHubWorkItem[] | null)[] = [],
  setPages?: (change: (current: (GitHubWorkItem[] | null)[]) => (GitHubWorkItem[] | null)[]) => void
): void {
  if (getTaskPageGitHubMutationQueryKey() === queryKey) {
    return
  }
  const currentOwner = createGitHubTaskObservationIndex(state.repos, (repo) =>
    getTaskPageRepoSourceContext(repo, 'github')
  )
  const transition: ListQueryTransition = {
    resolve(entries) {
      const addresses = new Map<string, ListEntry>()
      for (const entry of entries) {
        addresses.set(
          taskPageGitHubOwnedItemKey(
            entry.sourceScope,
            entry.repoId,
            entry.itemId,
            entry.observation?.key
          ) + entry.family,
          entry
        )
      }
      const inputs = new Map<ListEntry, ListInput>()
      const inspect = (row: Parameters<typeof listInput>[0]) => {
        const owner = currentOwner(row)
        for (const family of ['assignees', 'reviewRequests'] as const) {
          const matches = owner
            ? owner.associations.flatMap((association) => {
                const entry = addresses.get(
                  taskPageGitHubOwnedItemKey(
                    association.scope,
                    row.repoId,
                    taskPageGitHubMutationItemId(row),
                    association.key
                  ) + family
                )
                return entry ? [entry] : []
              })
            : []
          const legacy = addresses.get(
            taskPageGitHubOwnedItemKey(null, row.repoId, taskPageGitHubMutationItemId(row)) + family
          )
          if (legacy) {
            matches.push(legacy)
          }
          for (const entry of matches) {
            if (entry.itemType !== row.type || inputs.has(entry)) {
              continue
            }
            const input = listInput(row, family, entry.observation)
            if (input.kind === 'full') {
              inputs.set(entry, input)
            }
          }
        }
      }
      for (const page of pages ?? []) {
        for (const row of page ?? []) {
          inspect(row)
        }
      }
      for (const bucket of Object.values(state.workItemsCache)) {
        for (const row of bucket?.data ?? []) {
          inspect(row)
        }
      }
      return inputs
    },
    publish(plans) {
      if (!plans.length) {
        return
      }
      const requests = new Map(
        plans.map((plan) => [plan, new Map<string, GitHubWorkItemPatch>()] as const)
      )
      const lifetimes = new Map(
        plans.flatMap((plan) =>
          plan.retirement ? [[plan.retirement.fromLifetime, plan] as const] : []
        )
      )
      for (const bucket of Object.values(state.workItemsCache)) {
        for (const row of bucket?.data ?? []) {
          for (const family of ['assignees', 'reviewRequests'] as const) {
            const token = gitHubTaskFamilyOrigin(row, family)?.listLifetime
            const plan = token && lifetimes.get(token)
            if (!plan) {
              continue
            }
            const key = JSON.stringify([row.repoId, row.id])
            requests.get(plan)?.set(key, {
              itemId: row.id,
              repoId: row.repoId,
              patch: {},
              options: {
                sourceContext: plan.address.observation?.source,
                observation: plan.address.observation,
                ownerRepo:
                  row.type === 'issue' ? parseGitHubIssueOrPRLink(row.url)?.slug : undefined,
                listComposition: [plan]
              }
            })
          }
        }
      }
      state.patchWorkItems([...requests.values()].flatMap((selectors) => [...selectors.values()]))
      const apply = createTaskPageGitHubListCompositionProgram(plans)
      setPages?.((current) => {
        return current.map((page) => page?.map(apply) ?? null)
      })
    }
  }
  setTaskPageGitHubMutationQueryKey(queryKey, transition)
}
