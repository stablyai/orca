import { qualifyGitHubTaskLists } from './github-task-observation'

import { observeExistingListBases } from '@/components/task-page/github/task-page-github-work-item-mutation-registry'

import { useAppStore } from '@/store'

import { areTaskSourceContextsEqual } from '../../../shared/task-source-context'

import type { GitHubWorkItemDetails } from '../../../shared/github/work-item-types'

import {
  githubTaskContent,
  type captureGitHubTaskTarget,
  type GitHubTaskRefreshHandler
} from './github-task-target'

import {
  taskPageGitHubResumeCache,
  taskPageResumeContextHasSource
} from '@/components/task-page/github/task-page-github-resume-cache'

import { markGitHubTaskReads } from '@/store/github/request-coordination'

export function publishGitHubTaskRefresh(
  target: NonNullable<ReturnType<typeof captureGitHubTaskTarget>>,
  details: GitHubWorkItemDetails,
  onItem?: GitHubTaskRefreshHandler
) {
  const accepted = qualifyGitHubTaskLists(
    {
      ...target.item,
      ...githubTaskContent(details.item),
      githubObservation: target.observation,
      githubValueOrigins: {}
    },
    target.observation
  )
  const patch = {
    ...githubTaskContent(details.item),
    githubObservation: target.observation,
    githubValueOrigins: accepted.githubValueOrigins
  }
  observeExistingListBases(
    target.observations.flatMap((owner) =>
      owner
        ? [
            qualifyGitHubTaskLists(
              { ...accepted, githubObservation: owner, githubValueOrigins: {} },
              owner
            )
          ]
        : []
    )
  )
  const state = useAppStore.getState()
  state.patchWorkItem(target.item.id, patch, target.item.repoId, {
    observation: target.observation,
    sourceContext: target.source,
    sourceContexts: target.sources,
    hostId: target.hostId,
    ownerRepo: target.ownerRepo,
    matches: target.matches,
    valueOrigins: patch.githubValueOrigins
  })
  state.patchProjectTaskContent(accepted, details.body, target.source)
  useAppStore.setState((current) => {
    const selected = current.githubTaskDrawerWorkItem
    if (
      !target.sources.some((source) =>
        areTaskSourceContextsEqual(source, current.taskPageData.openGitHubSourceContext)
      )
    ) {
      return current
    }
    const seed = current.taskPageData.openGitHubWorkItem
    return {
      ...(selected && target.matches(selected)
        ? { githubTaskDrawerWorkItem: { ...selected, ...patch } }
        : {}),
      ...(seed && target.matches(seed)
        ? { taskPageData: { ...current.taskPageData, openGitHubWorkItem: { ...seed, ...patch } } }
        : {})
    }
  })
  taskPageGitHubResumeCache.patch(
    (key) =>
      target.sources.some((source) =>
        taskPageResumeContextHasSource(
          key,
          target.item.repoId,
          source,
          target.observations.find((owner) => owner?.source === source)?.key
        )
      ),
    (row) => (target.matches(row) ? { ...row, ...patch } : row)
  )
  markGitHubTaskReads(target, accepted, details.body)
  onItem?.(accepted, target)
  return accepted
}
