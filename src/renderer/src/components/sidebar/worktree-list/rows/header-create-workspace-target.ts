import type { Project, ProjectHostSetup } from '../../../../../../shared/project/project-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import {
  ALL_EXECUTION_HOSTS_SCOPE,
  getRepoExecutionHostId,
  type ExecutionHostId,
  type ExecutionHostScope
} from '../../../../../../shared/execution-host/execution-host'
import {
  getRepoHostIdentity,
  getRepoRegistrationHostIds
} from '../../../../../../shared/repository/repo-host-identity'
import '@/lib/workspace/creation/new-workspace-composer-repo'
import { getNewWorkspaceDialogEligibleRepos } from '../../../../../../shared/new-workspace/new-workspace-dialog-repo'
import { useCallback } from 'react'
import { useAppStore } from '@/store'
import {
  getRepoWorkspaceCreationTargetHint,
  resolveWorkspaceCreationTarget,
  type WorkspaceCreationTargetHint
} from '@/lib/workspace/creation/project-host-workspace-target'

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
  return getNewWorkspaceDialogEligibleRepos(repos).some(
    (candidate) => getRepoHostIdentity(candidate) === identity
  )
    ? { initialWorkspaceTarget: getRepoWorkspaceCreationTargetHint(repo, projectHostSetups) }
    : {}
}

/** A header that names no host: create on the default host when the project is ready there. */
export function getUnpinnedHeaderCreateWorkspaceTarget(
  repo: Repo,
  state: {
    repos: readonly Repo[]
    projects: readonly Project[]
    projectHostSetups: readonly ProjectHostSetup[]
    workspaceHostScope: ExecutionHostScope
  },
  hostId: ExecutionHostId
): { initialWorkspaceTarget?: WorkspaceCreationTargetHint } {
  // A host-filtered sidebar or a repo already on the default host keeps the repo path.
  if (
    state.workspaceHostScope !== ALL_EXECUTION_HOSTS_SCOPE ||
    getRepoExecutionHostId(repo) === hostId
  ) {
    return {}
  }
  const target = {
    projectId: getRepoWorkspaceCreationTargetHint(repo, state.projectHostSetups).projectId,
    hostId
  }
  const resolution = resolveWorkspaceCreationTarget({
    eligibleRepos: getNewWorkspaceDialogEligibleRepos(state.repos),
    projects: state.projects,
    projectHostSetups: state.projectHostSetups,
    ...target
  })
  // An unresolvable hint would leave Run on pending instead of falling back to the repo's host.
  return resolution.status === 'ready' ? { initialWorkspaceTarget: target } : {}
}

/** A project header's Create: pinned to its host when its rows all sit there, else to the sidebar's default host. */
export function useHeaderCreateComposer(
  defaultHostId: ExecutionHostId
): (repo: Repo, options: { pinHost: boolean }) => void {
  return useCallback(
    (repo, { pinHost }) => {
      const state = useAppStore.getState()
      state.openModal('new-workspace-composer', {
        initialRepoId: repo.id,
        ...(pinHost
          ? getHeaderCreateWorkspaceTarget(repo, state.repos, state.projectHostSetups)
          : getUnpinnedHeaderCreateWorkspaceTarget(repo, state, defaultHostId)),
        telemetrySource: 'sidebar'
      })
    },
    [defaultHostId]
  )
}
