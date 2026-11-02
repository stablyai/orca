/** Thrown by the boards IPC when the probe ran and the remote is not Azure DevOps. */
export const AZURE_DEVOPS_REMOTE_REQUIRED_ERROR = 'azure_devops_remote_required'
/**
 * Thrown when the repo lives on a remote host and the remote-url probe returned
 * nothing: the host could not be reached, so nothing is known about the remote.
 */
export const AZURE_DEVOPS_REPO_UNVERIFIABLE_ERROR = 'azure_devops_repo_unverifiable'

export type AzureDevOpsBoardsRepoArgs = {
  repoPath: string
  /** Registered repo id; lets the main process resolve WSL git options. */
  repoId?: string | null
  connectionId?: string | null
}

/** ADO accepts a team id or name in team-scoped routes; the id survives renames. */
export type AzureDevOpsTeamRoute = { teamName: string; teamId?: string | null }

export function azureDevOpsTeamRouteSegment(team: AzureDevOpsTeamRoute): string {
  return team.teamId ?? team.teamName
}

export function classifyAzureDevOpsRepoError(
  error: unknown
): 'remote-required' | 'unverifiable' | null {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes(AZURE_DEVOPS_REPO_UNVERIFIABLE_ERROR)) {
    return 'unverifiable'
  }
  if (message.includes(AZURE_DEVOPS_REMOTE_REQUIRED_ERROR)) {
    return 'remote-required'
  }
  return null
}
