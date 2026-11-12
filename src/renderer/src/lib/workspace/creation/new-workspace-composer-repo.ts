import {
  getRepoExecutionHostId,
  isRuntimeOwnedSshTargetId,
  parseExecutionHostId
} from '../../../../../shared/execution-host'
import '../../../../../shared/new-workspace-dialog-repo'
import { getProjectIdentityKey } from '../../../../../shared/project-host-setup-projection'
import type { Repo } from '../../../../../shared/repo-types'
import {
  isEphemeralVmRuntimeEnvironment,
  type PublicKnownRuntimeEnvironment
} from '../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { isRepoHidden } from '../../../../../shared/hidden-projects'

type RuntimeEnvironmentSource = Pick<PublicKnownRuntimeEnvironment, 'id' | 'source'>

/** Per-workspace runtimes come in two kinds: runtime-owned SSH targets and ephemeral-VM Orca servers. */
function isPerWorkspaceRuntimeRepo(
  repo: Repo,
  runtimeEnvironments: readonly RuntimeEnvironmentSource[]
): boolean {
  if (isRuntimeOwnedSshTargetId(repo.connectionId)) {
    return true
  }
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  if (host?.kind !== 'runtime') {
    return false
  }
  const environment = runtimeEnvironments.find((entry) => entry.id === host.environmentId)
  return environment ? isEphemeralVmRuntimeEnvironment(environment) : false
}

/** Map hidden per-workspace-runtime repos to their visible project sibling so composer selection cannot fall back to another project. */
export function resolveComposerActiveRepoId(
  repos: readonly Repo[],
  eligibleRepos: readonly Repo[],
  activeRepoId: string | null | undefined,
  runtimeEnvironments: readonly RuntimeEnvironmentSource[]
): string | null {
  if (!activeRepoId) {
    return activeRepoId ?? null
  }
  const activeRepo = repos.find((repo) => repo.id === activeRepoId)
  if (!activeRepo || !isPerWorkspaceRuntimeRepo(activeRepo, runtimeEnvironments)) {
    return activeRepoId
  }
  const projectKey = getProjectIdentityKey(activeRepo)
  const sibling = eligibleRepos.find(
    (repo) =>
      getProjectIdentityKey(repo) === projectKey &&
      !isPerWorkspaceRuntimeRepo(repo, runtimeEnvironments)
  )
  return sibling?.id ?? activeRepoId
}

/** The active workspace seeds the default, unless its project is loaded and every copy is hidden; while repos load, it still seeds. */
export function resolveComposerSeedRepoId(
  repos: readonly Repo[],
  eligibleRepos: readonly Repo[],
  activeRepoId: string | null | undefined,
  runtimeEnvironments: readonly RuntimeEnvironmentSource[]
): string | null {
  const activeRows = repos.filter((repo) => repo.id === activeRepoId)
  if (activeRows.length > 0 && activeRows.every(isRepoHidden)) {
    return null
  }
  return resolveComposerActiveRepoId(repos, eligibleRepos, activeRepoId, runtimeEnvironments)
}
