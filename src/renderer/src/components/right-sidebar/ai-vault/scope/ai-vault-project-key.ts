import type { ProjectHostSetup } from '../../../../../../shared/project/project-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { toAiVaultProjectKey } from '../../../../../../shared/ai-vault/scanning/ai-vault-project-key'

export function resolveActiveProjectKey(
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
