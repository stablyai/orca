import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  getRepoHostIdentity,
  getRepoRegistrationHostIds
} from '../../../../shared/repo-host-identity'
import { getComposerEligibleRepos } from '@/lib/new-workspace-composer-repo'
import { useAppStore } from '@/store'
import {
  getRepoWorkspaceCreationTargetHint,
  type WorkspaceCreationTargetHint
} from '@/lib/project-host-workspace-target'

/** A single-host project header's create target, when its repo id alone can't pick the host. */
export function getHeaderCreateWorkspaceTarget(
  repo: Repo,
  repos: readonly Repo[],
  projectHostSetups: readonly ProjectHostSetup[]
): { initialWorkspaceTarget?: WorkspaceCreationTargetHint } {
  // A unique id already names one checkout; a host hint would canonicalize to the host's first one.
  if (getRepoRegistrationHostIds(repos, repo.id).size < 2) {
    return {}
  }
  const identity = getRepoHostIdentity(repo)
  // Plumbing repos the composer can't target keep the id path, which maps them to an eligible sibling.
  return getComposerEligibleRepos(repos).some(
    (candidate) => getRepoHostIdentity(candidate) === identity
  )
    ? { initialWorkspaceTarget: getRepoWorkspaceCreationTargetHint(repo, projectHostSetups) }
    : {}
}

/** A project header's Create: the composer seeded with its repo, pinned to its host when its rows all sit there. */
export function openHeaderCreateComposer(repo: Repo, { pinHost }: { pinHost: boolean }): void {
  const { repos, projectHostSetups, openModal } = useAppStore.getState()
  openModal('new-workspace-composer', {
    initialRepoId: repo.id,
    ...(pinHost ? getHeaderCreateWorkspaceTarget(repo, repos, projectHostSetups) : {}),
    telemetrySource: 'sidebar'
  })
}
