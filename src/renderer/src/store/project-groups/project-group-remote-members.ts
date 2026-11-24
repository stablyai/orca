import type {
  ProjectGroup,
  ProjectGroupRemoteMember
} from '../../../../shared/project/groups/project-group-types'
import type { Repo } from '../../../../shared/repository/repo-types'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import { getProjectGroupRemoteMemberKey } from '../../../../shared/project/groups/project-group-remote-members'
import { getDistinctProjectGroups } from '../../../../shared/project/groups/project-groups'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/rpc/targets/runtime-client-target'

type GroupOwnerFields = Pick<ProjectGroup, 'connectionId' | 'executionHostId'>
type RemoteMembership = { groupId: string; order?: number }
export type RemoteMemberGroupMutation = {
  groupId: string
  hostId: ExecutionHostId
  updates: { remoteMembers: ProjectGroupRemoteMember[] }
}

/** Groups saved in this client's own catalog; only these may hold projects from other computers. */
export function isClientProjectGroup(group: GroupOwnerFields): boolean {
  return ipcOrRuntimeTargetForHostId(getRepoExecutionHostId(group))?.kind === 'local'
}

export function isRemoteProjectHost(hostId: string): boolean {
  return parseExecutionHostId(hostId)?.kind === 'runtime'
}

/** A project joins a group on its own host, or a client group when it lives on another computer. */
export function canProjectJoinGroupHost(
  projectHostId: ExecutionHostId,
  groupHostId: ExecutionHostId | null | undefined
): boolean {
  if (!groupHostId) {
    return false
  }
  return (
    groupHostId === projectHostId ||
    (isRemoteProjectHost(projectHostId) &&
      ipcOrRuntimeTargetForHostId(groupHostId)?.kind === 'local')
  )
}

function indexRemoteMemberships(
  groups: readonly ProjectGroup[]
): ReadonlyMap<string, RemoteMembership> {
  const index = new Map<string, RemoteMembership>()
  for (const group of groups) {
    if (!group.remoteMembers?.length || !isClientProjectGroup(group)) {
      continue
    }
    for (const member of group.remoteMembers) {
      const key = getProjectGroupRemoteMemberKey(member.hostId, member.projectId)
      if (!index.has(key)) {
        index.set(key, { groupId: group.id, order: member.order })
      }
    }
  }
  return index
}

export function findRemoteProjectGroupMembership(
  groups: readonly ProjectGroup[],
  repo: Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>
): RemoteMembership | null {
  const hostId = getRepoExecutionHostId(repo)
  if (!isRemoteProjectHost(hostId)) {
    return null
  }
  return indexRemoteMemberships(groups).get(getProjectGroupRemoteMemberKey(hostId, repo.id)) ?? null
}

const sidebarReposCache = new WeakMap<
  readonly Repo[],
  { groups: readonly ProjectGroup[]; repos: readonly Repo[] }
>()

/** Repo rows as the sidebar groups them: a client group membership overrides the host's own. */
export function applyRemoteProjectGroupMembers(
  repos: readonly Repo[],
  groups: readonly ProjectGroup[]
): readonly Repo[] {
  const cached = sidebarReposCache.get(repos)
  if (cached?.groups === groups) {
    return cached.repos
  }
  const index = indexRemoteMemberships(groups)
  let changed = false
  const next =
    index.size === 0
      ? repos
      : repos.map((repo) => {
          const hostId = getRepoExecutionHostId(repo)
          const membership = isRemoteProjectHost(hostId)
            ? index.get(getProjectGroupRemoteMemberKey(hostId, repo.id))
            : undefined
          if (!membership) {
            return repo
          }
          changed = true
          const { projectGroupOrder: _hostOrder, ...rest } = repo
          return {
            ...rest,
            projectGroupId: membership.groupId,
            ...(membership.order !== undefined ? { projectGroupOrder: membership.order } : {})
          }
        })
  const result = changed ? next : repos
  sidebarReposCache.set(repos, { groups, repos: result })
  return result
}

export function selectSidebarRepos(state: {
  repos: readonly Repo[]
  projectGroups: readonly ProjectGroup[]
}): readonly Repo[] {
  return applyRemoteProjectGroupMembers(state.repos, state.projectGroups)
}

/** Client group writes that put a remote project in `groupId`, or take it out of every client group when null. */
export function planRemoteProjectGroupMove(
  groups: readonly ProjectGroup[],
  repo: Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>,
  groupId: string | null,
  order?: number
): RemoteMemberGroupMutation[] {
  const hostId = getRepoExecutionHostId(repo)
  const key = getProjectGroupRemoteMemberKey(hostId, repo.id)
  const mutations: RemoteMemberGroupMutation[] = []
  for (const group of getDistinctProjectGroups(groups.filter(isClientProjectGroup))) {
    const members = group.remoteMembers ?? []
    const others = members.filter(
      (member) => getProjectGroupRemoteMemberKey(member.hostId, member.projectId) !== key
    )
    if (group.id === groupId) {
      const member = { hostId, projectId: repo.id, ...(order !== undefined ? { order } : {}) }
      mutations.push({
        groupId: group.id,
        hostId: getRepoExecutionHostId(group),
        updates: { remoteMembers: [...others, member] }
      })
    } else if (others.length !== members.length) {
      mutations.push({
        groupId: group.id,
        hostId: getRepoExecutionHostId(group),
        updates: { remoteMembers: others }
      })
    }
  }
  return mutations
}

/** Drop members a connected host no longer reports; an offline host never gets here, so its members stay. */
export function planStaleRemoteMemberRemoval(
  groups: readonly ProjectGroup[],
  hostId: ExecutionHostId,
  reportedProjectIds: ReadonlySet<string>
): RemoteMemberGroupMutation[] {
  if (!isRemoteProjectHost(hostId)) {
    return []
  }
  return getDistinctProjectGroups(groups.filter(isClientProjectGroup)).flatMap((group) => {
    const members = group.remoteMembers ?? []
    const kept = members.filter(
      (member) => member.hostId !== hostId || reportedProjectIds.has(member.projectId)
    )
    return kept.length === members.length
      ? []
      : [
          {
            groupId: group.id,
            hostId: getRepoExecutionHostId(group),
            updates: { remoteMembers: kept }
          }
        ]
  })
}

/** Call only with a host's applied live list; a seed or a skipped catalog would drop members of a project that still exists. */
export function pruneStaleRemoteProjectGroupMembers(
  state: {
    projectGroups: readonly ProjectGroup[]
    updateProjectGroups: (mutations: readonly RemoteMemberGroupMutation[]) => Promise<boolean>
  },
  catalog: { hostId: ExecutionHostId; repos: readonly Pick<Repo, 'id'>[] }
): void {
  const mutations = planStaleRemoteMemberRemoval(
    state.projectGroups,
    catalog.hostId,
    new Set(catalog.repos.map((repo) => repo.id))
  )
  if (mutations.length > 0) {
    void state.updateProjectGroups(mutations)
  }
}
