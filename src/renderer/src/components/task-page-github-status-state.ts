import type { GitHubWorkItem } from '../../../shared/types'

type GitHubStatusItem = Pick<GitHubWorkItem, 'id' | 'state'>

export type TaskPageGitHubStatusStateDraft = {
  sourceItemId: string
  sourceState: GitHubWorkItem['state']
  localState: GitHubWorkItem['state']
}

export function createTaskPageGitHubStatusStateDraft(
  item: GitHubStatusItem
): TaskPageGitHubStatusStateDraft {
  return {
    sourceItemId: item.id,
    sourceState: item.state,
    localState: item.state
  }
}

export function resolveTaskPageGitHubStatusStateDraft(
  state: TaskPageGitHubStatusStateDraft,
  item: GitHubStatusItem
): TaskPageGitHubStatusStateDraft {
  return state.sourceItemId === item.id && state.sourceState === item.state
    ? state
    : createTaskPageGitHubStatusStateDraft(item)
}

export function updateTaskPageGitHubStatusLocalState(
  state: TaskPageGitHubStatusStateDraft,
  item: GitHubStatusItem,
  localState: GitHubWorkItem['state']
): TaskPageGitHubStatusStateDraft {
  return {
    ...resolveTaskPageGitHubStatusStateDraft(state, item),
    localState
  }
}
