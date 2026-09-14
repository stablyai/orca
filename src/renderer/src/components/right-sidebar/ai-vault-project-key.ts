import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

export function toAiVaultProjectKey(
  projectId: string | null | undefined,
  repoId?: string | null
): string | null {
  if (projectId) {
    // Why: legacy projections can already use repo-prefixed project ids; wrapping
    // them again would split active scope and resolved session keys.
    return projectId.startsWith('repo:') ? projectId : `project:${projectId}`
  }
  return repoId ? `repo:${repoId}` : null
}

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
