import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId
} from '../../../../shared/execution-host'
import type { getProjectHostSetupLookup } from '../../../../shared/project-host-setup-lookup'
import type { ProjectHostSetup } from '../../../../shared/project-types'
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

export function resolveLegacyActiveProjectKey(
  activeRepo: Repo | null,
  activeWorktree: Worktree | null,
  setupByRepoId: ReadonlyMap<string, ProjectHostSetup>
): string | null {
  if (activeWorktree?.projectId) {
    return toAiVaultProjectKey(activeWorktree.projectId, activeWorktree.repoId)
  }

  const setup =
    (activeRepo ? setupByRepoId.get(activeRepo.id) : null) ??
    (activeWorktree ? setupByRepoId.get(activeWorktree.repoId) : null)
  if (setup) {
    return toAiVaultProjectKey(setup.projectId, setup.repoId || activeRepo?.id)
  }

  return toAiVaultProjectKey(null, activeRepo?.id ?? activeWorktree?.repoId ?? null)
}

export function buildSetupByRepoId(
  setups: readonly ProjectHostSetup[]
): ReadonlyMap<string, ProjectHostSetup> {
  const setupByRepoId = new Map<string, ProjectHostSetup>()
  for (const setup of setups) {
    if (setup.repoId && !setupByRepoId.has(setup.repoId)) {
      setupByRepoId.set(setup.repoId, setup)
    }
  }
  return setupByRepoId
}
