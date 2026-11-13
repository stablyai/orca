import { useAppStore } from '@/store/index'
import type { TaskPageJiraCreationMetadataModel } from '../../jira/use-task-page-jira-creation-metadata'

// Why the list projection's input model: the landing run's later-stage model carries these same fields.
type LandingRequestInput = Pick<
  TaskPageJiraCreationMetadataModel,
  'selectedReposKey' | 'appliedTaskSearch' | 'taskRefreshNonce' | 'workItemsInvalidationNonce'
>

/** The request a landing run dispatches for these inputs; until a run records it, that request is owed. */
export function taskPageGitHubLandingRequestKey(input: LandingRequestInput): string {
  return JSON.stringify([
    input.selectedReposKey,
    input.appliedTaskSearch,
    input.taskRefreshNonce,
    input.workItemsInvalidationNonce
  ])
}

/**
 * Whether the selected GitHub collection is still waiting for its answer. Never pending outside GitHub items or with
 * no selected owner. Otherwise pending while the landing request dispatched for an unanswered collection is in flight,
 * or, with no accepted answer for the selected scope, while that request is owed or a selected owner's source save is
 * pending. An answer is accepted data: page one needs every selected row's cache entry (an empty list included).
 */
export function useTaskPageGitHubListPending(
  model: LandingRequestInput &
    Pick<
      TaskPageJiraCreationMetadataModel,
      | 'selectedRepos'
      | 'taskSource'
      | 'githubMode'
      | 'tasksLoading'
      | 'landingRequestKey'
      | 'selectedWorkItemsCacheEntries'
      | 'pages'
      | 'currentPage'
    >
): boolean {
  const { selectedRepos, tasksLoading, selectedWorkItemsCacheEntries, pages, currentPage } = model
  // Why a store selector: a save's begin and settlement publish repos/nonce, and retirement runs inside that publication.
  const savePending = useAppStore((s) =>
    selectedRepos.some((repo) => s.githubSourceCollections.saving(repo))
  )
  if (model.taskSource !== 'github' || model.githubMode !== 'items' || selectedRepos.length === 0) {
    return false
  }
  // Why: contributors' entries land before the aggregate publishes its page, so its own request decides until then.
  if (tasksLoading) {
    return true
  }
  const answered =
    currentPage > 0
      ? Boolean(pages[currentPage])
      : selectedWorkItemsCacheEntries.length > 0 &&
        selectedWorkItemsCacheEntries.every((entry) => Boolean(entry?.data))
  const owed = model.landingRequestKey !== taskPageGitHubLandingRequestKey(model)
  return !answered && (owed || savePending)
}
