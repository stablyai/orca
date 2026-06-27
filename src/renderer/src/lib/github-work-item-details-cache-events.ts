import type { TaskSourceContext } from '../../../shared/task-source-context'

export type GitHubWorkItemDetailsCacheMutation = {
  repoPath: string
  repoId?: string
  sourceContext?: TaskSourceContext | null
  type: 'issue' | 'pr'
  number: number
}

const GITHUB_WORK_ITEM_DETAILS_CACHE_MUTATED_EVENT = 'orca:github-work-item-details-cache-mutated'

export function emitGitHubWorkItemDetailsCacheMutation(
  payload: GitHubWorkItemDetailsCacheMutation
): void {
  window.dispatchEvent(
    new CustomEvent<GitHubWorkItemDetailsCacheMutation>(
      GITHUB_WORK_ITEM_DETAILS_CACHE_MUTATED_EVENT,
      { detail: payload }
    )
  )
}

export function onGitHubWorkItemDetailsCacheMutation(
  listener: (payload: GitHubWorkItemDetailsCacheMutation) => void
): () => void {
  const handler = (event: Event): void => {
    listener((event as CustomEvent<GitHubWorkItemDetailsCacheMutation>).detail)
  }
  window.addEventListener(GITHUB_WORK_ITEM_DETAILS_CACHE_MUTATED_EVENT, handler)
  return () => window.removeEventListener(GITHUB_WORK_ITEM_DETAILS_CACHE_MUTATED_EVENT, handler)
}
