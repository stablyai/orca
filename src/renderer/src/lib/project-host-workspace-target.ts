import {
  ALL_EXECUTION_HOSTS_SCOPE,
  type ExecutionHostId,
  type ExecutionHostScope
} from '../../../shared/execution-host'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import type { Project, ProjectHostSetup, Repo } from '../../../shared/types'
import { resolveComposerRepoId } from './new-workspace-composer-repo'

export type WorkspaceCreationTarget = {
  projectId: string
  hostId: ExecutionHostId
  projectHostSetupId: string
  repoId: string
  repo: Repo
  setup: ProjectHostSetup
}

export type WorkspaceCreationTargetResolution =
  | { status: 'ready'; target: WorkspaceCreationTarget }
  | {
      status: 'unavailable'
      reason:
        | 'no-eligible-repo'
        | 'project-not-found'
        | 'project-not-set-up-on-host'
        | 'project-has-no-ready-setup'
        | 'setup-not-found'
        | 'setup-not-ready'
    }

type ProjectHostWorkspaceTargetInput = {
  eligibleRepos: readonly Repo[]
  projects?: readonly Project[]
  projectHostSetups?: readonly ProjectHostSetup[]
  draftRepoId?: string | null
  initialRepoId?: string | null
  activeRepoId?: string | null
  projectId?: string | null
  hostId?: ExecutionHostId | null
  projectHostSetupId?: string | null
  focusedHostScope?: ExecutionHostScope | null
}

type ProjectSetupModel = {
  projects: readonly Project[]
  setups: readonly ProjectHostSetup[]
}

function getProjectSetupModel({
  eligibleRepos,
  projects,
  projectHostSetups
}: Pick<
  ProjectHostWorkspaceTargetInput,
  'eligibleRepos' | 'projects' | 'projectHostSetups'
>): ProjectSetupModel | null {
  if (projects?.length || projectHostSetups?.length) {
    return {
      projects: projects ?? [],
      setups: projectHostSetups ?? []
    }
  }
  if (eligibleRepos.length === 0) {
    return null
  }
  const projection = projectHostSetupProjectionFromRepos(eligibleRepos)
  return {
    projects: projection.projects,
    setups: projection.setups
  }
}

function isReadySetup(setup: ProjectHostSetup): boolean {
  return setup.setupState === 'ready'
}

function createTarget(
  setup: ProjectHostSetup,
  repoById: ReadonlyMap<string, Repo>
): WorkspaceCreationTarget | null {
  const repo = repoById.get(setup.repoId)
  if (!repo) {
    return null
  }
  return {
    projectId: setup.projectId,
    hostId: setup.hostId,
    projectHostSetupId: setup.id,
    repoId: setup.repoId,
    repo,
    setup
  }
}

function findReadySetupTarget(
  setups: readonly ProjectHostSetup[],
  repoById: ReadonlyMap<string, Repo>,
  predicate: (setup: ProjectHostSetup) => boolean
): WorkspaceCreationTarget | null {
  for (const setup of setups) {
    if (!isReadySetup(setup) || !predicate(setup)) {
      continue
    }
    const target = createTarget(setup, repoById)
    if (target) {
      return target
    }
  }
  return null
}

export function resolveWorkspaceCreationTarget(
  input: ProjectHostWorkspaceTargetInput
): WorkspaceCreationTargetResolution {
  const { eligibleRepos, focusedHostScope, hostId, projectHostSetupId, projectId } = input
  if (eligibleRepos.length === 0) {
    return { status: 'unavailable', reason: 'no-eligible-repo' }
  }

  const model = getProjectSetupModel(input)
  const repoById = new Map(eligibleRepos.map((repo) => [repo.id, repo]))
  const setups = model?.setups ?? []

  if (projectHostSetupId) {
    const setup = setups.find((entry) => entry.id === projectHostSetupId)
    if (!setup) {
      return { status: 'unavailable', reason: 'setup-not-found' }
    }
    if (!isReadySetup(setup)) {
      return { status: 'unavailable', reason: 'setup-not-ready' }
    }
    const target = createTarget(setup, repoById)
    if (target) {
      return { status: 'ready', target }
    }
    return { status: 'unavailable', reason: 'setup-not-found' }
  }

  if (projectId && !model?.projects.some((project) => project.id === projectId)) {
    return { status: 'unavailable', reason: 'project-not-found' }
  }

  if (projectId && hostId) {
    const hostSetup = setups.find(
      (setup) => setup.projectId === projectId && setup.hostId === hostId
    )
    if (hostSetup && !isReadySetup(hostSetup)) {
      return { status: 'unavailable', reason: 'setup-not-ready' }
    }
    const target = findReadySetupTarget(
      setups,
      repoById,
      (setup) => setup.projectId === projectId && setup.hostId === hostId
    )
    if (target) {
      return { status: 'ready', target }
    }
    return { status: 'unavailable', reason: 'project-not-set-up-on-host' }
  }

  if (projectId) {
    const focusedHostId =
      focusedHostScope && focusedHostScope !== ALL_EXECUTION_HOSTS_SCOPE ? focusedHostScope : null
    const focusedTarget = focusedHostId
      ? findReadySetupTarget(
          setups,
          repoById,
          (setup) => setup.projectId === projectId && setup.hostId === focusedHostId
        )
      : null
    if (focusedTarget) {
      return { status: 'ready', target: focusedTarget }
    }
    const target = findReadySetupTarget(setups, repoById, (setup) => setup.projectId === projectId)
    if (target) {
      return { status: 'ready', target }
    }
    return { status: 'unavailable', reason: 'project-has-no-ready-setup' }
  }

  if (hostId) {
    const target = findReadySetupTarget(setups, repoById, (setup) => setup.hostId === hostId)
    if (target) {
      return { status: 'ready', target }
    }
  }

  const repoId = resolveComposerRepoId(input)
  const legacyRepo = repoId ? repoById.get(repoId) : null
  if (!legacyRepo) {
    return { status: 'unavailable', reason: 'no-eligible-repo' }
  }

  const legacySetup =
    setups.find((setup) => setup.repoId === legacyRepo.id && isReadySetup(setup)) ??
    projectHostSetupProjectionFromRepos([legacyRepo]).setups[0]
  const legacyTarget = legacySetup ? createTarget(legacySetup, repoById) : null
  if (!legacyTarget) {
    return { status: 'unavailable', reason: 'setup-not-found' }
  }
  return { status: 'ready', target: legacyTarget }
}

export function resolveWorkspaceCreationRepoId(input: ProjectHostWorkspaceTargetInput): string {
  const resolution = resolveWorkspaceCreationTarget(input)
  return resolution.status === 'ready' ? resolution.target.repoId : ''
}
