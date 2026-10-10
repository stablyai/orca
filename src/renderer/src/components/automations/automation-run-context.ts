import {
  buildWorkspaceRunContext,
  type WorkspaceRunContext
} from '../../../../shared/task-source-context'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { AutomationHostTarget } from './automation-host-client'
import { getRepoCatalogOwnerHostId } from '../../store/projects/project-catalog-owner'

export function buildAutomationRunContextForRepo(args: {
  repoId: string
  repos: readonly Repo[]
  projectHostSetups: readonly ProjectHostSetup[]
}): WorkspaceRunContext | null {
  const matchingRepos = args.repos.filter((candidate) => candidate.id === args.repoId)
  if (matchingRepos.length !== 1) {
    return null
  }
  const repo = matchingRepos[0]
  const hostId = getRepoExecutionHostId(repo)
  const setup = args.projectHostSetups.find(
    (candidate) =>
      candidate.repoId === repo.id &&
      candidate.hostId === hostId &&
      candidate.setupState === 'ready'
  )
  if (!setup) {
    return null
  }
  return buildWorkspaceRunContext({
    projectId: setup.projectId,
    hostId: setup.hostId,
    projectHostSetupId: setup.id,
    repoId: setup.repoId,
    path: setup.path || repo.path
  })
}

export function getRuntimeTargetHostId(
  target: AutomationHostTarget | null | undefined
): string | null {
  return target?.kind === 'environment'
    ? `runtime:${encodeURIComponent(target.environmentId)}`
    : null
}

export function setupHostMatchesRunContext(
  setupHostId: string,
  runHostId: string,
  target: AutomationHostTarget | null | undefined
): boolean {
  if (setupHostId === runHostId) {
    return true
  }
  const targetHostId = getRuntimeTargetHostId(target)
  // Why: remote-runtime project lists project the server-local host as runtime:<env>,
  // while CLI-created automations can preserve the server's durable local run host.
  return targetHostId !== null && setupHostId === targetHostId && runHostId === 'local'
}

export function repoHostMatchesRunContext(
  repo: Repo,
  runHostId: string,
  target: AutomationHostTarget | null | undefined
): boolean {
  const publisherHostId =
    target?.kind === 'local'
      ? 'local'
      : (getRuntimeTargetHostId(target) ?? getRepoCatalogOwnerHostId(repo))
  if (getRepoCatalogOwnerHostId(repo) !== publisherHostId) {
    return false
  }
  if (repo.authoritativeExecutionHostId) {
    return repo.authoritativeExecutionHostId === runHostId
  }
  if (runHostId === getRepoExecutionHostId(repo)) {
    return true
  }
  const targetHostId = getRuntimeTargetHostId(target)
  // Why: repos fetched from a remote runtime are owned by runtime:<env> in the
  // renderer, but saved automations still target the host setup that runs there.
  return targetHostId !== null && getRepoExecutionHostId(repo) === targetHostId
}
