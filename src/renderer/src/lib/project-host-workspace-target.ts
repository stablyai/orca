import {
  ALL_EXECUTION_HOSTS_SCOPE,
  getRepoExecutionHostId,
  type ExecutionHostId,
  type ExecutionHostScope
} from '../../../shared/execution-host'
import {
  chooseReadyProjectHostSetup,
  isReadyProjectHostSetup
} from '../../../shared/project-host-setup-choice'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import type { Project, ProjectHostSetup } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
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
      // Why (STA-6080): several ready setups matched, and storage order is not a choice. Callers
      // surface the candidates instead of creating the workspace in whichever one came first.
      status: 'ambiguous'
      projectId: string | null
      candidates: readonly WorkspaceCreationTarget[]
    }
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
  actionableHostIds?: ReadonlySet<ExecutionHostId>
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

function createTarget(
  setup: ProjectHostSetup,
  reposById: ReadonlyMap<string, readonly Repo[]>
): WorkspaceCreationTarget | null {
  const candidates = reposById.get(setup.repoId) ?? []
  const repo =
    candidates.find((candidate) => getRepoExecutionHostId(candidate) === setup.hostId) ??
    (candidates.length === 1 ? candidates[0] : null)
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

function chooseReadyTarget(
  setups: readonly ProjectHostSetup[],
  reposById: ReadonlyMap<string, readonly Repo[]>,
  predicate: (setup: ProjectHostSetup) => boolean
) {
  const targets: WorkspaceCreationTarget[] = []
  for (const setup of setups) {
    if (!isReadyProjectHostSetup(setup) || !predicate(setup)) {
      continue
    }
    const target = createTarget(setup, reposById)
    if (target) {
      targets.push(target)
    }
  }
  return chooseReadyProjectHostSetup(targets)
}

function ambiguousResolution(
  candidates: readonly WorkspaceCreationTarget[]
): WorkspaceCreationTargetResolution {
  const [first] = candidates
  const sharedProjectId = candidates.every((candidate) => candidate.projectId === first.projectId)
    ? first.projectId
    : null
  return { status: 'ambiguous', projectId: sharedProjectId, candidates }
}

export function resolveWorkspaceCreationTarget(
  input: ProjectHostWorkspaceTargetInput
): WorkspaceCreationTargetResolution {
  const { eligibleRepos, focusedHostScope, hostId, projectHostSetupId, projectId } = input
  if (eligibleRepos.length === 0) {
    return { status: 'unavailable', reason: 'no-eligible-repo' }
  }

  const model = getProjectSetupModel(input)
  const reposById = new Map<string, Repo[]>()
  for (const repo of eligibleRepos) {
    const candidates = reposById.get(repo.id) ?? []
    candidates.push(repo)
    reposById.set(repo.id, candidates)
  }
  const actionableHostIds = input.actionableHostIds
  const allSetups = model?.setups ?? []
  const setups = actionableHostIds
    ? allSetups.filter((setup) => actionableHostIds.has(setup.hostId))
    : allSetups

  if (projectHostSetupId) {
    const setup = allSetups.find((entry) => entry.id === projectHostSetupId)
    if (!setup) {
      return { status: 'unavailable', reason: 'setup-not-found' }
    }
    if (actionableHostIds && !actionableHostIds.has(setup.hostId)) {
      // Why: the caller named this exact setup. Silently creating the workspace on a
      // sibling host would put files (and any agent run) somewhere the user never chose,
      // so fail closed and let them re-pick a host.
      return { status: 'unavailable', reason: 'setup-not-found' }
    }
    if (!isReadyProjectHostSetup(setup)) {
      return { status: 'unavailable', reason: 'setup-not-ready' }
    }
    // Why: the caller named this exact setup, so it is the one to create in — a same-host duplicate
    // from a legacy profile is a peer the picker also offers, never a reason to redirect.
    const target = createTarget(setup, reposById)
    if (target) {
      return { status: 'ready', target }
    }
    return { status: 'unavailable', reason: 'setup-not-found' }
  }

  if (projectId && !model?.projects.some((project) => project.id === projectId)) {
    return { status: 'unavailable', reason: 'project-not-found' }
  }

  if (projectId && hostId) {
    const choice = chooseReadyTarget(
      setups,
      reposById,
      (setup) => setup.projectId === projectId && setup.hostId === hostId
    )
    if (choice.status === 'ambiguous') {
      return ambiguousResolution(choice.candidates)
    }
    if (choice.status === 'single') {
      return { status: 'ready', target: choice.setup }
    }
    // A legacy profile can retain a pending row alongside a ready duplicate. The ready row is
    // actionable; report pending only when no ready setup exists for the requested host.
    if (
      setups.some(
        (setup) =>
          setup.projectId === projectId &&
          setup.hostId === hostId &&
          !isReadyProjectHostSetup(setup)
      )
    ) {
      return { status: 'unavailable', reason: 'setup-not-ready' }
    }
    return { status: 'unavailable', reason: 'project-not-set-up-on-host' }
  }

  if (projectId) {
    const focusedHostId =
      focusedHostScope && focusedHostScope !== ALL_EXECUTION_HOSTS_SCOPE ? focusedHostScope : null
    const focusedChoice = focusedHostId
      ? chooseReadyTarget(
          setups,
          reposById,
          (setup) => setup.projectId === projectId && setup.hostId === focusedHostId
        )
      : null
    if (focusedChoice?.status === 'ambiguous') {
      return ambiguousResolution(focusedChoice.candidates)
    }
    if (focusedChoice?.status === 'single') {
      return { status: 'ready', target: focusedChoice.setup }
    }
    const choice = chooseReadyTarget(setups, reposById, (setup) => setup.projectId === projectId)
    if (choice.status === 'ambiguous') {
      return ambiguousResolution(choice.candidates)
    }
    if (choice.status === 'single') {
      return { status: 'ready', target: choice.setup }
    }
    return { status: 'unavailable', reason: 'project-has-no-ready-setup' }
  }

  if (hostId) {
    const choice = chooseReadyTarget(setups, reposById, (setup) => setup.hostId === hostId)
    if (choice.status === 'ambiguous') {
      return ambiguousResolution(choice.candidates)
    }
    if (choice.status === 'single') {
      return { status: 'ready', target: choice.setup }
    }
    // Why: the caller named this host. Falling through to the legacy repo (or any other
    // actionable host) would create the workspace somewhere the user never selected.
    return { status: 'unavailable', reason: 'project-not-set-up-on-host' }
  }

  const repoId = resolveComposerRepoId(input)
  const legacyCandidates = repoId ? (reposById.get(repoId) ?? []) : []
  const focusedLegacyRepo =
    focusedHostScope && focusedHostScope !== ALL_EXECUTION_HOSTS_SCOPE
      ? legacyCandidates.find((candidate) => getRepoExecutionHostId(candidate) === focusedHostScope)
      : null
  const legacyRepo =
    focusedLegacyRepo ?? (legacyCandidates.length === 1 ? legacyCandidates[0] : null)
  let legacyTarget: WorkspaceCreationTarget | null = null
  let repoIdChoice: ReturnType<typeof chooseReadyTarget> | null = null
  if (legacyRepo) {
    const projectedLegacySetup = projectHostSetupProjectionFromRepos([legacyRepo]).setups[0]
    const legacyHostId = getRepoExecutionHostId(legacyRepo)
    const legacySetup =
      setups.find(
        (setup) =>
          setup.repoId === legacyRepo.id &&
          setup.hostId === legacyHostId &&
          isReadyProjectHostSetup(setup)
      ) ??
      (!actionableHostIds || actionableHostIds.has(projectedLegacySetup.hostId)
        ? projectedLegacySetup
        : null)
    legacyTarget = legacySetup ? createTarget(legacySetup, reposById) : null
  } else if (repoId) {
    // Why: duplicate repo ids across hosts leave no single legacy repo. Stay on the resolved id's
    // own setup instead of failing closed and letting the composer re-pick an arbitrary repo.
    repoIdChoice = chooseReadyTarget(setups, reposById, (setup) => setup.repoId === repoId)
    legacyTarget = repoIdChoice.status === 'single' ? repoIdChoice.setup : null
  }
  if (legacyTarget) {
    return { status: 'ready', target: legacyTarget }
  }
  if (repoIdChoice?.status === 'ambiguous') {
    return ambiguousResolution(repoIdChoice.candidates)
  }
  const fallbackChoice = chooseReadyTarget(setups, reposById, () => true)
  if (fallbackChoice.status === 'ambiguous') {
    return ambiguousResolution(fallbackChoice.candidates)
  }
  if (fallbackChoice.status === 'single') {
    return { status: 'ready', target: fallbackChoice.setup }
  }
  return { status: 'unavailable', reason: legacyRepo ? 'setup-not-found' : 'no-eligible-repo' }
}

export function resolveWorkspaceCreationRepoId(input: ProjectHostWorkspaceTargetInput): string {
  const resolution = resolveWorkspaceCreationTarget(input)
  return resolution.status === 'ready' ? resolution.target.repoId : ''
}
