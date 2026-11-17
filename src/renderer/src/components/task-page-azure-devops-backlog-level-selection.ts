import type { AzureDevOpsBacklogLevel } from '../../../shared/azure-devops/boards-types'
import { classifyAzureDevOpsRepoError } from '../../../shared/azure-devops/boards-repo-resolution'

export type AzureDevOpsViewsStatus =
  | 'idle'
  /** The probe ran and the remote is not Azure DevOps. */
  | 'not-azure-remote'
  /** Remote host could not be reached; nothing is known about the remote. */
  | 'host-unreachable'
  | 'unauthenticated'
  | 'loading'
  | 'ready'
  | 'error'

export function resolveAzureDevOpsLoadFailure(error: unknown): {
  status: Extract<AzureDevOpsViewsStatus, 'not-azure-remote' | 'host-unreachable' | 'error'>
  message: string
} {
  const message = error instanceof Error ? error.message : String(error)
  const kind = classifyAzureDevOpsRepoError(error)
  if (kind === 'remote-required') {
    return { status: 'not-azure-remote', message }
  }
  if (kind === 'unverifiable') {
    return { status: 'host-unreachable', message }
  }
  return { status: 'error', message }
}

export function azureDevOpsTeamSelectionKey(repo: {
  organization: string | null
  project: string
}): string {
  return `${repo.organization ?? 'collection'}/${repo.project}`
}

/** Levels the picker offers: ADO's Backlogs hub lists portfolio + requirement levels only. */
export function listVisibleAzureDevOpsLevels(
  levels: readonly AzureDevOpsBacklogLevel[]
): AzureDevOpsBacklogLevel[] {
  return levels.filter((l) => !l.hidden && l.kind !== 'task')
}

export function pickDefaultAzureDevOpsLevel(
  levels: readonly AzureDevOpsBacklogLevel[]
): AzureDevOpsBacklogLevel | null {
  const visible = listVisibleAzureDevOpsLevels(levels)
  return visible.find((l) => l.kind === 'requirement') ?? visible[0] ?? null
}
