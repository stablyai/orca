import type { GroupHeaderRow } from '../../../shared/sidebar-list/row-types'
import { buildProjectSetupRepoLookup } from './project-setup-repo-lookup'
import {
  buildProjectGroupingIndex,
  type ProjectGroupingIndex
} from '../../../shared/project-section-grouping'
import {
  selectProjectGroupTarget,
  type ProjectGroupingSettings
} from '../../../shared/project-grouping'
import {
  ALL_EXECUTION_HOSTS_SCOPE,
  getRepoExecutionHostId,
  type ExecutionHostId,
  type ExecutionHostScope
} from '../../../shared/execution-host'
import {
  getProjectIdentityKey,
  projectHostSetupProjectionFromRepos
} from '../../../shared/project-host-setup-projection'
import type { Project, ProjectHostSetup } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import { resolveComposerRepoId } from './new-workspace-composer-repo'
import { findSoleHostCopy } from '../../../shared/worktree/host-qualified-identity'

export type WorkspaceCreationTarget = {
  projectId: string
  hostId: ExecutionHostId
  projectHostSetupId: string
  repoId: string
  repo: Repo
  setup: ProjectHostSetup
}

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

export type WorkspaceCreationProjectScope = NonNullable<GroupHeaderRow['projectScope']>

type ProjectHostWorkspaceTargetInput = {
  projectScope?: WorkspaceCreationProjectScope | null
  grouping?: ProjectGroupingIndex
  settings?: ProjectGroupingSettings | null
  path?: string | null
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

function isReadySetup(setup: ProjectHostSetup): boolean {
  return setup.setupState === 'ready'
}

type SetupRepoLookup = ReturnType<typeof buildProjectSetupRepoLookup>

function createTarget(
  setup: ProjectHostSetup,
  lookup: SetupRepoLookup
): WorkspaceCreationTarget | null {
  const repo = lookup.resolve(setup)
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
  lookup: SetupRepoLookup,
  predicate: (setup: ProjectHostSetup) => boolean
): WorkspaceCreationTarget | null {
  for (const setup of setups) {
    if (!isReadySetup(setup) || !predicate(setup)) {
      continue
    }
    const target = createTarget(setup, lookup)
    if (target) {
      return target
    }
  }
  return null
}

export function resolveWorkspaceCreationTarget(
  input: ProjectHostWorkspaceTargetInput
): WorkspaceCreationTargetResolution {
  const { eligibleRepos, focusedHostScope, hostId, projectHostSetupId } = input
  const projectId = input.projectId ?? input.projectScope?.key
  if (eligibleRepos.length === 0) {
    return { status: 'unavailable', reason: 'no-eligible-repo' }
  }

  const model = getProjectSetupModel(input)
  const lookup = buildProjectSetupRepoLookup(eligibleRepos)
  const reposById = lookup.byId
  const actionableHostIds = input.actionableHostIds
  const allSetups = model?.setups ?? []
  const setups = actionableHostIds
    ? allSetups.filter((setup) => actionableHostIds.has(setup.hostId))
    : allSetups

  if (projectHostSetupId) {
    const matchingSetups = allSetups.filter((entry) => entry.id === projectHostSetupId)
    const setupHostId = input.projectHostSetupHostId ?? (matchingSetups.length > 1 ? hostId : null)
    // Unnamed: only actionable copies compete, so a lone runnable host still resolves.
    const setup = findSoleHostCopy(
      setupHostId
        ? matchingSetups.filter((entry) => entry.hostId === setupHostId)
        : matchingSetups.filter(
            (entry) => !actionableHostIds || actionableHostIds.has(entry.hostId)
          ),
      (entry) => entry.hostId
    )
    if (!setup) {
      return { status: 'unavailable', reason: 'setup-not-found' }
    }
    if (actionableHostIds && !actionableHostIds.has(setup.hostId)) {
      // Exact setup selection must fail closed; a sibling host would run files/agents somewhere the user never chose.
      return { status: 'unavailable', reason: 'setup-not-found' }
    }
    if (!isReadySetup(setup)) {
      return { status: 'unavailable', reason: 'setup-not-ready' }
    }
    const explicit = createTarget(setup, lookup)
    if (explicit) {
      return { status: 'ready', target: explicit }
    }
    return { status: 'unavailable', reason: 'setup-not-found' }
  }

  if (projectId && model) {
    const index =
      input.grouping ??
      buildProjectGroupingIndex({
        projects: model.projects,
        projectHostSetups: allSetups,
        settings: input.settings
      })
    const group = index.groupByKey.get(projectId)
    if (input.projectScope && !group) {
      return { status: 'unavailable', reason: 'project-not-found' }
    }
    const projectSetups = setups.filter((setup) =>
      group
        ? index.groupByRepoHost.get(`${setup.hostId}\0${setup.repoId}`)?.key === group.key
        : setup.projectId === projectId
    )
    if (!group && !model.projects.some((project) => project.id === projectId)) {
      return { status: 'unavailable', reason: 'project-not-found' }
    }
    const requestedHost =
      hostId ??
      (focusedHostScope && focusedHostScope !== ALL_EXECUTION_HOSTS_SCOPE ? focusedHostScope : null)
    const ready = projectSetups.filter(isReadySetup)
    if (hostId && !projectSetups.some((setup) => setup.hostId === hostId)) {
      return { status: 'unavailable', reason: 'project-not-set-up-on-host' }
    }
    if (hostId && !ready.some((setup) => setup.hostId === hostId)) {
      return { status: 'unavailable', reason: 'setup-not-ready' }
    }
    const candidates = ready.filter(
      (setup) => (!hostId || setup.hostId === hostId) && createTarget(setup, lookup) !== null
    )
    if (candidates.length > 0) {
      const selected = selectProjectGroupTarget(
        {
          key: group?.key ?? projectId,
          label: '',
          members: candidates,
          representative: candidates[0]
        },
        {
          path: input.path,
          contextualRepoId:
            input.draftRepoId ??
            input.initialRepoId ??
            input.projectScope?.context?.repoId ??
            input.activeRepoId,
          ...(!input.draftRepoId && !input.initialRepoId
            ? {
                contextualHostId: input.projectScope?.context?.hostId,
                contextualSetupId: input.projectScope?.context?.setupId
              }
            : {}),
          hostId: requestedHost
        }
      )
      const target = createTarget(selected, lookup)
      if (target) {
        return { status: 'ready', target }
      }
    }
    return { status: 'unavailable', reason: 'project-has-no-ready-setup' }
  }

  if (hostId) {
    const target = findReadySetupTarget(setups, lookup, (setup) => setup.hostId === hostId)
    if (target) {
      return { status: 'ready', target }
    }
    // Explicit host selection must never fall through to another ready host or legacy repo.
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
  if (legacyRepo) {
    const projectedLegacySetup = projectHostSetupProjectionFromRepos([legacyRepo]).setups[0]
    const legacyHostId = getRepoExecutionHostId(legacyRepo)
    const legacySetup =
      setups.find(
        (setup) =>
          setup.repoId === legacyRepo.id && setup.hostId === legacyHostId && isReadySetup(setup)
      ) ??
      (!actionableHostIds || actionableHostIds.has(projectedLegacySetup.hostId)
        ? projectedLegacySetup
        : null)
    legacyTarget = legacySetup ? createTarget(legacySetup, lookup) : null
  } else if (repoId) {
    // Cross-host duplicate repo IDs are ambiguous; retain the resolved setup instead of letting the composer repick arbitrarily.
    legacyTarget = findReadySetupTarget(setups, lookup, (setup) => setup.repoId === repoId)
  }
  if (legacyTarget) {
    return { status: 'ready', target: legacyTarget }
  }
  if (input.draftRepoId && reposById.has(input.draftRepoId)) {
    // An explicit repo must not fall back to a different ready project/host.
    return { status: 'unavailable', reason: 'setup-not-found' }
  }
  const fallbackTarget = findReadySetupTarget(setups, lookup, () => true)
  return fallbackTarget
    ? { status: 'ready', target: fallbackTarget }
    : { status: 'unavailable', reason: legacyRepo ? 'setup-not-found' : 'no-eligible-repo' }
}

export function resolveWorkspaceCreationRepoId(input: ProjectHostWorkspaceTargetInput): string {
  const resolution = resolveWorkspaceCreationTarget(input)
  return resolution.status === 'ready' ? resolution.target.repoId : ''
}
