import { getRepoExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { ExecutionHostRegistryEntry } from '../../../shared/execution-host-registry'
import type { ProjectHostSetup } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import {
  chooseReadyProjectHostSetup,
  isReadyProjectHostSetup
} from '../../../shared/project-host-setup-choice'
import { dedupeReadySetupRows } from './project-host-setup-row-dedupe'

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

export function createTarget(
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

export function chooseReadyTarget(
  setups: readonly ProjectHostSetup[],
  reposById: ReadonlyMap<string, readonly Repo[]>,
  predicate: (setup: ProjectHostSetup) => boolean,
  hosts: readonly ExecutionHostRegistryEntry[] = []
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
  return chooseReadyProjectHostSetup(
    dedupeReadySetupRows(
      targets.map((target) => ({
        ...target,
        id: target.projectHostSetupId,
        path: target.setup.path
      })),
      new Map(hosts.map((host) => [host.id, host]))
    )
  )
}

export function ambiguousResolution(
  candidates: readonly WorkspaceCreationTarget[]
): WorkspaceCreationTargetResolution {
  const [first] = candidates
  const sharedProjectId = candidates.every((candidate) => candidate.projectId === first.projectId)
    ? first.projectId
    : null
  return { status: 'ambiguous', projectId: sharedProjectId, candidates }
}

export function getWorkspaceCreationTargetChoice(resolution: WorkspaceCreationTargetResolution) {
  return {
    projectId:
      resolution.status === 'ready'
        ? resolution.target.projectId
        : resolution.status === 'ambiguous'
          ? resolution.projectId
          : null,
    candidates: resolution.status === 'ambiguous' ? resolution.candidates : null
  }
}
