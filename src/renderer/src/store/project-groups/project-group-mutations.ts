import { initializeNewRootProjectGroupOrder } from './project-group-update-persistence'
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import { selectProjectGroupRemovalTargets } from './project-group-removal-targets'
import {
  projectGroupMatchesOwnerHost,
  resolveProjectGroupOwnerHostId,
  runtimeTargetForProjectGroupOwner
} from './project-group-owner-routing'
import { findRepoForHost, repoMatchesHostIdentity } from '../repos/repo-host-identity'
import { callRuntimeRpc } from '../../runtime/rpc/calls/runtime-rpc-call'
import {
  getRuntimeTargetHostId,
  ipcOrRuntimeTargetForHostId
} from '../../runtime/rpc/targets/runtime-client-target'
import {
  getRepoExecutionHostId,
  getSshTargetIdForExecutionHost
} from '../../../../shared/execution-host'
import type { ProjectRemovalFailure, RepoSlice } from '../repos/repo-state'
import { applyProjectGroupDeleteCascade } from './project-group-removal-state'
import { adoptFromEndpoint } from '../host-catalog/endpoint-catalog-adoption'
import { notifyProjectGroupParentMoveRejected } from './project-group-mutation-toasts'
import { executeMoveProjectToGroup } from './project-group-repo-move'

export function createProjectGroupMutationActions(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<
  RepoSlice,
  | 'createProjectGroup'
  | 'updateProjectGroup'
  | 'deleteProjectGroup'
  | 'deleteProjectGroupWithContainedProjects'
  | 'moveProjectToGroup'
> {
  return {
    createProjectGroup: async (name, hostId, options) => {
      try {
        // Why: a new group lands on the host of the project or parent group that owns it, not the focused one.
        const target = ipcOrRuntimeTargetForHostId(hostId)
        if (!target) {
          return null
        }
        const parentGroupId = options?.parentGroupId?.trim() || null
        const connectionId = target.kind === 'local' ? getSshTargetIdForExecutionHost(hostId) : null
        const payload = {
          name,
          createdFrom: 'manual' as const,
          ...(connectionId ? { connectionId } : {}),
          ...(parentGroupId ? { parentGroupId } : {})
        }
        const group =
          target.kind === 'local'
            ? await window.api.projectGroups.create(payload)
            : (
                await callRuntimeRpc<{ group: ProjectGroup }>(
                  target,
                  'projectGroup.create',
                  payload,
                  { timeoutMs: 15_000 }
                )
              ).group
        if (parentGroupId && (group.parentGroupId ?? null) !== parentGroupId) {
          const cleanedUp =
            target.kind === 'environment'
              ? await callRuntimeRpc<{ deleted: boolean }>(
                  target,
                  'projectGroup.delete',
                  { groupId: group.id },
                  { timeoutMs: 15_000 }
                )
                  .then((res) => res.deleted === true)
                  .catch(() => false)
              : false
          if (cleanedUp) {
            set((s) => applyProjectGroupDeleteCascade(s, group.id, getRuntimeTargetHostId(target)))
          } else {
            const strayGroup = adoptFromEndpoint(target, { kind: 'projectGroup', row: group })
            const strayHostId = getRepoExecutionHostId(strayGroup)
            set((s) => {
              const exists = s.projectGroups.some((entry) =>
                projectGroupMatchesOwnerHost(entry, strayGroup.id, strayHostId)
              )
              return exists ? s : { projectGroups: [...s.projectGroups, strayGroup] }
            })
          }
          notifyProjectGroupParentMoveRejected()
          options?.onParentMoveRejected?.()
          return null
        }
        const orderedGroup = await initializeNewRootProjectGroupOrder(target, group, get())
        const ownedGroup = adoptFromEndpoint(target, { kind: 'projectGroup', row: orderedGroup })
        const ownerHostId = getRepoExecutionHostId(ownedGroup)
        set((s) => {
          const existing = s.projectGroups.find((entry) =>
            projectGroupMatchesOwnerHost(entry, ownedGroup.id, ownerHostId)
          )
          if (existing && orderedGroup === group) {
            return s
          }
          // Keep newer catalog fields, but include the order confirmed after that refresh.
          const { rootProjectOrder, tabOrder } = ownedGroup
          const nextGroup = existing ? { ...existing, rootProjectOrder, tabOrder } : ownedGroup
          return {
            projectGroups: existing
              ? s.projectGroups.map((entry) => (entry === existing ? nextGroup : entry))
              : [...s.projectGroups, nextGroup],
            folderWorkspacePathStatuses: {}
          }
        })
        return ownedGroup
      } catch (err) {
        console.error('Failed to create project group:', err)
        return null
      }
    },

    updateProjectGroup: (groupId, updates, options) =>
      get().updateProjectGroups([{ groupId, updates, hostId: options?.hostId }]),

    deleteProjectGroup: async (groupId, options) => {
      try {
        const ownerHostId = resolveProjectGroupOwnerHostId(get(), groupId, options?.hostId)
        const target = runtimeTargetForProjectGroupOwner(get(), groupId, options?.hostId)
        if (!target) {
          return false
        }
        const deleted =
          target.kind === 'local'
            ? await window.api.projectGroups.delete({ groupId })
            : (
                await callRuntimeRpc<{ deleted: boolean }>(
                  target,
                  'projectGroup.delete',
                  { groupId },
                  { timeoutMs: 15_000 }
                )
              ).deleted
        if (!deleted) {
          return false
        }
        set((s) => applyProjectGroupDeleteCascade(s, groupId, ownerHostId))
        return true
      } catch (err) {
        console.error('Failed to delete project group:', err)
        return false
      }
    },

    deleteProjectGroupWithContainedProjects: async (groupId, options) => {
      const ownerHostId = resolveProjectGroupOwnerHostId(get(), groupId, options.hostId)
      const targets = selectProjectGroupRemovalTargets(
        get().projectGroups,
        get().repos,
        groupId,
        ownerHostId
      )
      const requestedProjectIds = options.removeContainedProjects ? targets.projectIds : []
      if (!targets.groupExists) {
        return {
          status: 'missing-group',
          groupId,
          requestedProjectIds,
          removedProjectIds: [],
          failedProjectRemovals: []
        }
      }

      const deleted = await get().deleteProjectGroup(groupId, {
        hostId: ownerHostId ?? undefined
      })
      if (!deleted) {
        return {
          status: 'group-delete-failed',
          groupId,
          requestedProjectIds,
          removedProjectIds: [],
          failedProjectRemovals: []
        }
      }

      if (!options.removeContainedProjects) {
        return {
          status: 'deleted-group',
          groupId,
          requestedProjectIds,
          removedProjectIds: [],
          failedProjectRemovals: []
        }
      }

      const removedProjectIds: string[] = []
      const failedProjectRemovals: ProjectRemovalFailure[] = []
      // Cascade captured members by host; same-ID rows outside this group on other hosts must survive.
      const membersById = new Map<string, Repo[]>()
      for (const member of targets.projects) {
        const row = findRepoForHost(get().repos, member.id, { hostId: member.hostId })
        if (row) {
          membersById.set(member.id, [...(membersById.get(member.id) ?? []), row])
        }
      }
      for (const projectId of new Set(targets.projectIds)) {
        const members = membersById.get(projectId) ?? []
        // Why: an unstamped group already routes to the focused host, so only that host's member is removed.
        const focusedMember = ownerHostId
          ? null
          : findRepoForHost(members, projectId, { settings: get().settings })
        const removable = ownerHostId ? members : focusedMember ? [focusedMember] : []
        const removableHostIds = removable.map((row) => getRepoExecutionHostId(row))
        for (const hostId of removableHostIds) {
          try {
            await get().removeProject(projectId, {
              hostId,
              confirmedDiscards: options.confirmedDiscards
            })
          } catch (err) {
            console.error('Failed to remove contained project:', err)
          }
        }
        // Why: an ambiguous unstamped member with no focused-host row was left in place, so it counts as remaining.
        const stillExists =
          (members.length > 0 && removableHostIds.length === 0) ||
          removableHostIds.some((hostId) =>
            get().repos.some((repo) => repoMatchesHostIdentity(repo, projectId, hostId))
          )
        if (stillExists) {
          failedProjectRemovals.push({
            projectId,
            reason: 'Project remained in Orca after removeProject completed.'
          })
        } else {
          removedProjectIds.push(projectId)
        }
      }

      return {
        status: 'deleted-group',
        groupId,
        requestedProjectIds,
        removedProjectIds,
        failedProjectRemovals
      }
    },

    moveProjectToGroup: async (project, groupId, order) =>
      executeMoveProjectToGroup(set, get, project, groupId, order)
  }
}
