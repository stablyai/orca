import {
  ALL_EXECUTION_HOSTS_SCOPE,
  getRepoExecutionHostId,
  type ExecutionHostId,
  type ExecutionHostScope
} from '../../../shared/execution-host'
import { isReadyProjectHostSetup } from '../../../shared/project-host-setup-choice'
import {
  getProjectIdentityKey,
  projectHostSetupProjectionFromRepos
} from '../../../shared/project-host-setup-projection'
import type { ExecutionHostRegistryEntry } from '../../../shared/execution-host-registry'
import type { Project, ProjectHostSetup } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import { resolveComposerRepoId } from './new-workspace-composer-repo'
import {
  ambiguousResolution,
  chooseReadyTarget,
  createTarget,
  type WorkspaceCreationTarget,
  type WorkspaceCreationTargetResolution
} from './workspace-creation-target-choice'

export type {
  WorkspaceCreationTarget,
  WorkspaceCreationTargetResolution
} from './workspace-creation-target-choice'

export type WorkspaceCreationTargetHint = Pick<WorkspaceCreationTarget, 'projectId' | 'hostId'> & {
  projectHostSetupId?: string | null
}

export function getRepoWorkspaceCreationTargetHint(
  repo: Repo,
  projectHostSetups: readonly ProjectHostSetup[]
): WorkspaceCreationTargetHint {
  const hostId = getRepoExecutionHostId(repo)
  const setup = projectHostSetups.find(
    (candidate) => candidate.repoId === repo.id && candidate.hostId === hostId
  )
  return {
    projectId: setup?.projectId ?? getProjectIdentityKey(repo),
    hostId,
    ...(setup ? { projectHostSetupId: setup.id } : {})
  }
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
  projectHostSetupHostId?: ExecutionHostId | null
  hosts?: readonly ExecutionHostRegistryEntry[]
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
    const matchingSetups = allSetups.filter((entry) => entry.id === projectHostSetupId)
    const setupHostId = input.projectHostSetupHostId ?? (matchingSetups.length > 1 ? hostId : null)
    const setup = matchingSetups.find((entry) => !setupHostId || entry.hostId === setupHostId)
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
    // Preserve an exact setup choice even when another checkout shares its host.
    const target = createTarget(setup, reposById)
    if (target) {
      return { status: 'ready', target }
    }
    return { status: 'unavailable', reason: 'setup-not-found' }
  }

  if (projectId && !model?.projects.some((project) => project.id === projectId)) {
    return { status: 'unavailable', reason: 'project-not-found' }
  }

  const explicitRepoId = input.draftRepoId ?? input.initialRepoId
  if (projectId && explicitRepoId) {
    const matchesExplicitRepo = (setup: ProjectHostSetup): boolean =>
      setup.projectId === projectId &&
      setup.repoId === explicitRepoId &&
      (!hostId || setup.hostId === hostId)
    if (allSetups.some(matchesExplicitRepo)) {
      return resolveWorkspaceCreationTarget({
        ...input,
        projectId: null,
        hostId: null,
        projectHostSetups: allSetups.filter(matchesExplicitRepo),
        focusedHostScope: hostId ?? focusedHostScope
      })
    }
  }

  if (projectId && hostId) {
    const choice = chooseReadyTarget(
      setups,
      reposById,
      (setup) => setup.projectId === projectId && setup.hostId === hostId,
      input.hosts
    )
    if (choice.status === 'ambiguous') {
      return ambiguousResolution(choice.candidates)
    }
    if (choice.status === 'single') {
      return { status: 'ready', target: choice.setup }
    }
    // A pending legacy duplicate must not hide a ready checkout.
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
          (setup) => setup.projectId === projectId && setup.hostId === focusedHostId,
          input.hosts
        )
      : null
    if (focusedChoice?.status === 'ambiguous') {
      return ambiguousResolution(focusedChoice.candidates)
    }
    if (focusedChoice?.status === 'single') {
      return { status: 'ready', target: focusedChoice.setup }
    }
    const choice = chooseReadyTarget(
      setups,
      reposById,
      (setup) => setup.projectId === projectId,
      input.hosts
    )
    if (choice.status === 'ambiguous') {
      return ambiguousResolution(choice.candidates)
    }
    if (choice.status === 'single') {
      return { status: 'ready', target: choice.setup }
    }
    return { status: 'unavailable', reason: 'project-has-no-ready-setup' }
  }

  if (hostId) {
    const choice = chooseReadyTarget(
      setups,
      reposById,
      (setup) => setup.hostId === hostId,
      input.hosts
    )
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
    const existingSetups = allSetups.filter(
      (setup) => setup.repoId === legacyRepo.id && setup.hostId === legacyHostId
    )
    const existingSetup = existingSetups.find(isReadyProjectHostSetup) ?? existingSetups[0]
    if (
      (existingSetup && !isReadyProjectHostSetup(existingSetup)) ||
      (actionableHostIds && !actionableHostIds.has(legacyHostId))
    ) {
      return {
        status: 'unavailable',
        reason:
          existingSetup && !isReadyProjectHostSetup(existingSetup)
            ? 'setup-not-ready'
            : 'setup-not-found'
      }
    }
    const hasExactRepoContext = [input.draftRepoId, input.initialRepoId, input.activeRepoId].some(
      (contextRepoId) => contextRepoId === legacyRepo.id
    )
    if (!hasExactRepoContext && legacySetup) {
      return resolveWorkspaceCreationTarget({ ...input, projectId: legacySetup.projectId })
    }
    legacyTarget = legacySetup ? createTarget(legacySetup, reposById) : null
  } else if (repoId) {
    // Why: duplicate repo ids across hosts leave no single legacy repo. Stay on the resolved id's
    // own setup instead of failing closed and letting the composer re-pick an arbitrary repo.
    repoIdChoice = chooseReadyTarget(
      setups,
      reposById,
      (setup) => setup.repoId === repoId,
      input.hosts
    )
    legacyTarget = repoIdChoice.status === 'single' ? repoIdChoice.setup : null
  }
  if (legacyTarget) {
    return { status: 'ready', target: legacyTarget }
  }
  if (repoIdChoice?.status === 'ambiguous') {
    return ambiguousResolution(repoIdChoice.candidates)
  }
  if (
    (input.draftRepoId && reposById.has(input.draftRepoId)) ||
    (input.initialRepoId && reposById.has(input.initialRepoId))
  ) {
    return { status: 'unavailable', reason: 'setup-not-found' }
  }
  const fallbackChoice = chooseReadyTarget(setups, reposById, () => true, input.hosts)
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
