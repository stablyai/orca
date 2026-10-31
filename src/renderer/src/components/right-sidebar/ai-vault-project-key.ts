import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId
} from '../../../../shared/execution-host'
import type { getProjectHostSetupLookup } from '../../../../shared/project-host-setup-lookup'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { toAiVaultProjectKey } from '../../../../shared/ai-vault-project-key'

export function resolveActiveProjectKey(
  activeRepo: Repo | null,
  activeWorktree: Worktree | null,
  owners: ReturnType<typeof getProjectHostSetupLookup>
): string | null {
  const execution = parseExecutionHostId(activeRepo ? getRepoExecutionHostId(activeRepo) : null)
  const owner =
    activeWorktree ??
    (activeRepo
      ? {
          repoId: activeRepo.id,
          hostId: activeRepo.connectionId
            ? toSshExecutionHostId(activeRepo.connectionId)
            : getRepoExecutionHostId(activeRepo),
          runtimeOwnerEnvironmentId:
            execution?.kind === 'runtime' ? execution.environmentId : undefined
        }
      : null)
  return toAiVaultProjectKey(owner ? owners.projectId(owner) : null, owner?.repoId ?? null)
}
