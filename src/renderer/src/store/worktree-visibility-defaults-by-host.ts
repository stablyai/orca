import { getRepoExecutionHostId, parseExecutionHostId } from '../../../shared/execution-host'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type {
  GlobalSettings,
  WorktreeVisibilityDefaults
} from '../../../shared/global-settings-types'
import type { Repo } from '../../../shared/repo-types'

export function getRepoOwnerWorktreeVisibilityDefaults(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>,
  settings: Pick<GlobalSettings, 'worktreeVisibilityDefaults'> | null | undefined,
  defaultsByHost: Partial<Record<ExecutionHostId, WorktreeVisibilityDefaults | null>> | undefined
): WorktreeVisibilityDefaults | undefined {
  const hostId = getRepoExecutionHostId(repo)
  if (parseExecutionHostId(hostId)?.kind === 'runtime') {
    return defaultsByHost?.[hostId] ?? undefined
  }
  return defaultsByHost?.local ?? settings?.worktreeVisibilityDefaults
}
