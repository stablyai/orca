/** Cross-layer contract: the runtime's non-checkout rejection is what clients match to offer a folder project instead. */
export const NON_GIT_REPO_REJECTION = 'Not a valid git repository'

export function formatNonGitRepoRejection(path: string): string {
  return `${NON_GIT_REPO_REJECTION}: ${path}`
}

export function isNonGitRepoRejection(message: string): boolean {
  return message.includes(NON_GIT_REPO_REJECTION)
}
