import {
  getRepoExecutionHostId,
  normalizeExecutionHostId,
  toRuntimeExecutionHostId
} from './execution-host'
import { getRepoHostIdentityForParts, getRepoSetupOwnerScope } from './repo-host-identity'
import type { ProjectHostSetup } from './project-types'
import type { Repo } from './repo-types'
import type { WorktreeMeta } from './worktree/meta-types'
import { projectHostSetupProjectionFromRepos } from './project-host-setup-projection'

type SetupOwner = Pick<ProjectHostSetup, 'projectId' | 'repoId'> &
  Partial<Pick<ProjectHostSetup, 'id' | 'hostId' | 'executionHostId' | 'connectionId'>>

export type WorkspaceProjectOwner = {
  repoId: string
  projectId?: string | null
  projectHostSetupId?: string
  hostId?: string | null
  runtimeOwnerEnvironmentId?: string
}

const ownerLookupCache = new WeakMap<readonly SetupOwner[], ProjectHostSetupLookup>()
const EMPTY_SETUPS: readonly SetupOwner[] = []

type ProjectHostSetupLookup = {
  forWorkspace: (workspace: WorkspaceProjectOwner) => SetupOwner | undefined
  projectId: (workspace: WorkspaceProjectOwner) => string | undefined
}

/** Resolve recorded workspace ownership and its host-scoped checkout fallback. */
export function getProjectHostSetupLookup(
  setups: readonly SetupOwner[] = EMPTY_SETUPS
): ProjectHostSetupLookup {
  const cached = ownerLookupCache.get(setups)
  if (cached) {
    return cached
  }
  const byRepo = new Map<string, SetupOwner | null>()
  const bySetup = new Map<string, SetupOwner | null>()
  const ownerKey = getRepoHostIdentityForParts
  const scope = getRepoSetupOwnerScope
  const add = (index: Map<string, SetupOwner | null>, key: string, setup: SetupOwner) => {
    const prior = index.get(key)
    index.set(
      key,
      prior === undefined ||
        (prior && prior.projectId === setup.projectId && scope(prior) === scope(setup))
        ? setup
        : null
    )
  }
  for (const setup of setups) {
    for (const [index, id] of [
      [byRepo, setup.repoId],
      [bySetup, setup.id ?? setup.repoId]
    ] as const) {
      if (!id) {
        continue
      }
      add(index, id, setup)
      add(index, ownerKey(id, scope(setup)), setup)
      if (scope(setup) !== setup.hostId) {
        add(index, ownerKey(id, setup.hostId ?? 'local'), setup)
      }
    }
  }
  const forWorkspace = (workspace: WorkspaceProjectOwner): SetupOwner | undefined => {
    const host = normalizeExecutionHostId(workspace.hostId)
    if (workspace.hostId && !host) {
      return undefined
    }
    const transport = workspace.runtimeOwnerEnvironmentId
      ? toRuntimeExecutionHostId(workspace.runtimeOwnerEnvironmentId)
      : host
    const ownerScope =
      transport && host?.startsWith('ssh:') && transport !== host
        ? `${transport}\0${host}`
        : transport
    const key = (id: string) => (ownerScope ? ownerKey(id, ownerScope) : id)
    if (workspace.projectHostSetupId) {
      const setupKey = key(workspace.projectHostSetupId)
      if (bySetup.has(setupKey)) {
        const setup = bySetup.get(setupKey)
        return setup?.repoId === workspace.repoId || !setup?.repoId
          ? (setup ?? undefined)
          : undefined
      }
      // Independent setup metadata must not be reassigned to the repo's default setup.
      if (workspace.projectHostSetupId !== workspace.repoId) {
        return undefined
      }
    }
    return byRepo.get(key(workspace.repoId)) ?? undefined
  }
  const lookup = {
    forWorkspace,
    projectId: (workspace: WorkspaceProjectOwner) =>
      workspace.projectId ?? forWorkspace(workspace)?.projectId ?? undefined
  }
  ownerLookupCache.set(setups, lookup)
  return lookup
}

export function getProjectHostSetupForRepo(
  setups: readonly ProjectHostSetup[],
  repo: Repo
): ProjectHostSetup {
  // A repo id can exist on multiple hosts; the host-qualified setup is authoritative.
  const executionHostId = getRepoExecutionHostId(repo)
  return (
    setups.find((setup) => setup.repoId === repo.id && setup.hostId === executionHostId) ??
    setups.find((setup) => setup.repoId === repo.id) ??
    projectHostSetupProjectionFromRepos([repo]).setups[0]
  )
}

export function getProjectHostSetupWorktreeMeta(
  setups: readonly ProjectHostSetup[],
  repo: Repo
): Pick<WorktreeMeta, 'projectId' | 'hostId' | 'projectHostSetupId'> {
  const setup = getProjectHostSetupForRepo(setups, repo)
  return {
    projectId: setup.projectId,
    hostId: setup.hostId,
    projectHostSetupId: setup.id
  }
}
