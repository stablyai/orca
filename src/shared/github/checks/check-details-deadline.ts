export const GITHUB_CHECK_DETAILS_HOST_TIMEOUT_MS = 25_000
export const GITHUB_CHECK_DETAILS_TIMEOUT_MESSAGE = 'Timed out loading check details.'

export function isGitHubCheckDetailsTimeout(error: unknown): boolean {
  return error instanceof Error && error.message.endsWith(GITHUB_CHECK_DETAILS_TIMEOUT_MESSAGE)
}
