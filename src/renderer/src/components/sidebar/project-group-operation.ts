import type { AppState } from '@/store/types'
import { getProjectGroupingIndexFromState } from '@/store/project-host-setup-selector'
import {
  resolveIndexedRepoOwner,
  resolveQualifiedIndexedRepoOwnerForHost
} from '@/lib/repo-owner-index'
import { getRepoRowIdentity } from '@/store/slices/repo-host-identity'
import {
  getRuntimeTargetHostId,
  ipcOrRuntimeTargetForHostId
} from '@/runtime/runtime-client-target'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { GroupingSetup } from '../../../../shared/project-grouping'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getProjectGroupHostId } from '@/store/slices/project-group-owner-routing'

export type ProjectGroupEntrance =
  | { kind: 'header'; groupKey: string; catalogHostId: ExecutionHostId }
  | { kind: 'worktree'; worktree: Worktree }
  | { kind: 'repo'; repo: Repo }

export type ProjectGroupOperation = {
  groupKey: string
  catalogHostId: ExecutionHostId
  members: readonly Repo[]
  destinations: readonly ProjectGroup[]
  complete: boolean
  grouped: boolean
  uniformGroupId: string | null | undefined
}

type OperationState = Pick<
  AppState,
  'repos' | 'projects' | 'projectHostSetups' | 'settings' | 'projectGroups'
>

export function projectGroupCatalog(hostId: ExecutionHostId): ExecutionHostId | null {
  const target = ipcOrRuntimeTargetForHostId(hostId)
  return target ? getRuntimeTargetHostId(target) : null
}

function setupConnection(setup: GroupingSetup): string | null {
  const execution = parseExecutionHostId(setup.executionHostId ?? setup.hostId)
  return setup.connectionId?.trim() || (execution?.kind === 'ssh' ? execution.targetId : null)
}

function setupIdentity(setup: GroupingSetup): string {
  return getRepoRowIdentity({
    id: setup.repoId,
    executionHostId: setup.hostId,
    connectionId: setupConnection(setup)
  })
}

export function currentProjectGroupMember(
  state: Pick<AppState, 'repos'>,
  member: Repo
): Repo | null {
  const match = resolveQualifiedIndexedRepoOwnerForHost(
    state.repos,
    member.id,
    getRepoExecutionHostId(member),
    member.connectionId ?? null
  )
  return match.kind === 'resolved' ? match.owner : null
}

function worktreeRegistration(state: OperationState, worktree: Worktree): Repo | null {
  const physical = parseExecutionHostId(worktree.hostId)
  const host = worktree.runtimeOwnerEnvironmentId
    ? toRuntimeExecutionHostId(worktree.runtimeOwnerEnvironmentId)
    : physical?.id
  if (host) {
    const match = resolveQualifiedIndexedRepoOwnerForHost(
      state.repos,
      worktree.repoId,
      host,
      physical?.kind === 'ssh' ? physical.targetId : undefined
    )
    return match.kind === 'resolved' ? match.owner : null
  }
  if (worktree.hostId) {
    return null
  }
  // Listing ingress admits unstamped rows to the sole owner; ambiguous legacy duplicates remain local.
  const sole = resolveIndexedRepoOwner(state.repos, worktree.repoId)
  const match = resolveQualifiedIndexedRepoOwnerForHost(
    state.repos,
    worktree.repoId,
    sole.kind === 'resolved' ? getRepoExecutionHostId(sole.owner) : 'local',
    sole.kind === 'resolved' ? (sole.owner.connectionId ?? null) : null
  )
  return match.kind === 'resolved' ? match.owner : null
}

/** Resolve only an open menu's current operation, never an occurrence's display ancestor. */
export function resolveProjectGroupOperation(
  state: OperationState,
  entrance: ProjectGroupEntrance
): ProjectGroupOperation | null {
  const index = getProjectGroupingIndexFromState(state)
  const source =
    entrance.kind === 'worktree'
      ? worktreeRegistration(state, entrance.worktree)
      : entrance.kind === 'repo'
        ? currentProjectGroupMember(state, entrance.repo)
        : null
  let group = entrance.kind === 'header' ? index.groupByKey.get(entrance.groupKey) : undefined
  if (entrance.kind !== 'header') {
    if (!source) {
      return null
    }
    const identity = getRepoRowIdentity(source)
    // Containment after physical folding is authoritative, not the host/raw convenience map.
    for (const candidate of index.groups) {
      for (const registration of candidate.registrations) {
        if (setupIdentity(registration) === identity) {
          group = candidate
        }
      }
    }
  }
  const entranceHost =
    entrance.kind === 'header'
      ? entrance.catalogHostId
      : source
        ? getRepoExecutionHostId(source)
        : null
  const catalogHostId = entranceHost ? projectGroupCatalog(entranceHost) : null
  if (!group || !catalogHostId) {
    return null
  }
  const members: Repo[] = []
  const seen = new Set<string>()
  let complete = true
  for (const setup of group.registrations) {
    if (!setup.repoId || projectGroupCatalog(setup.hostId) !== catalogHostId) {
      continue
    }
    const identity = setupIdentity(setup)
    if (seen.has(identity)) {
      continue
    }
    seen.add(identity)
    const match = resolveQualifiedIndexedRepoOwnerForHost(
      state.repos,
      setup.repoId,
      setup.hostId,
      setupConnection(setup)
    )
    if (match.kind !== 'resolved') {
      complete = false
    } else {
      members.push(match.owner)
    }
  }
  const destinations = new Map<string, ProjectGroup>()
  for (const destination of state.projectGroups) {
    if (projectGroupCatalog(getProjectGroupHostId(destination)) === catalogHostId) {
      destinations.set(destination.id, destination)
    }
  }
  const memberships = new Set(members.map((member) => member.projectGroupId ?? null))
  return {
    groupKey: group.key,
    catalogHostId,
    members,
    destinations: [...destinations.values()],
    complete: complete && members.length > 0,
    grouped: members.some((member) => Boolean(member.projectGroupId)),
    uniformGroupId:
      complete && members.length > 0 && memberships.size === 1
        ? memberships.values().next().value
        : undefined
  }
}

export function projectGroupOperationValues(operation: ProjectGroupOperation | null): unknown {
  return (
    operation && {
      groupKey: operation.groupKey,
      catalogHostId: operation.catalogHostId,
      complete: operation.complete,
      members: operation.members.map((member) => [
        getRepoRowIdentity(member),
        member.projectGroupId ?? null
      ]),
      destinations: operation.destinations.map((group) => [group.id, group.name])
    }
  )
}
