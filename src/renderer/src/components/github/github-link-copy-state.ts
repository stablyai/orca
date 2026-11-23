export type GitHubLinkCopyState = {
  workItemId: string | undefined
  copied: boolean
}

export function createGitHubLinkCopyState(workItemId: string | undefined): GitHubLinkCopyState {
  return { workItemId, copied: false }
}

export function resolveGitHubLinkCopyState(
  state: GitHubLinkCopyState,
  workItemId: string | undefined
): GitHubLinkCopyState {
  if (state.workItemId === workItemId) {
    return state
  }
  return createGitHubLinkCopyState(workItemId)
}

export function markGitHubLinkCopied(workItemId: string | undefined): GitHubLinkCopyState {
  return { workItemId, copied: true }
}

export function clearGitHubLinkCopied(
  state: GitHubLinkCopyState,
  workItemId: string | undefined
): GitHubLinkCopyState {
  if (state.workItemId !== workItemId || !state.copied) {
    return state
  }
  return createGitHubLinkCopyState(workItemId)
}
