import { initializeNewRootProjectGroupOrder } from './project-group-update-persistence'
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import { selectProjectGroupRemovalTargets } from './project-group-removal-targets'
import {
  isProjectGroupJoinableFromCatalog,
  projectGroupMatchesOwnerHost,
  resolveProjectGroupMutationTarget
} from './project-group-owner-routing'
import {
  findRepoForHost,
  isSameRepoRow,
  repoMatchesHostIdentity
} from '../repos/repo-host-identity'
import { callRuntimeRpc } from '../../runtime/rpc/calls/runtime-rpc-call'
import { ipcOrRuntimeTargetForHostId } from '../../runtime/rpc/targets/runtime-client-target'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { ProjectRemovalFailure, RepoSlice } from '../repos/repo-state'
import { mergeProjectCompatibilityForHostRepoChange } from '../repos/repo-catalog-identity'
import { applyProjectGroupDeleteCascade } from './project-group-removal-state'
import { adoptFromEndpoint } from '../host-catalog/endpoint-catalog-adoption'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

function notifyProjectGroupOnOtherHost(): void {
  toast.error(
    translate('auto.store.slices.repos.moveToGroupOtherHost', 'Could not move project to group'),
    {
      description: translate(
        'auto.store.slices.repos.moveToGroupOtherHostDesc',
        'The computer this project runs on does not have this group. A project can only join groups saved on its own computer.'
      )
    }
  )
}

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
    createProjectGroup: async (name, hostId) => {
      try {
        // Why: a new group lands on the host of the project that seeds it, not the focused one.
        const target = ipcOrRuntimeTargetForHostId(hostId)
        if (!target) {
          return null
        }
        const group =
          target.kind === 'local'
            ? await window.api.projectGroups.create({
                name,
                createdFrom: 'manual'
              })
            : (
                await callRuntimeRpc<{ group: ProjectGroup }>(
                  target,
                  'projectGroup.create',
                  { name, createdFrom: 'manual' },
                  { timeoutMs: 15_000 }
                )
              ).group
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
        const route = resolveProjectGroupMutationTarget(get(), groupId, options?.hostId)
        if (!route) {
          return false
        }
        const { target, ownerHostId } = route
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
      const route = resolveProjectGroupMutationTarget(get(), groupId, options.hostId)
      const targets = route
        ? selectProjectGroupRemovalTargets(
            get().projectGroups,
            get().repos,
            groupId,
            route.ownerHostId
          )
        : null
      if (!route || !targets?.groupExists) {
        return {
          status: 'missing-group',
          groupId,
          requestedProjectIds: [],
          removedProjectIds: [],
          failedProjectRemovals: []
        }
      }
      const { ownerHostId } = route
      const requestedProjectIds = options.removeContainedProjects ? targets.projectIds : []

      const deleted = await get().deleteProjectGroup(groupId, { hostId: ownerHostId })
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
        const removableHostIds = members.map((row) => getRepoExecutionHostId(row))
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
        const stillExists = removableHostIds.some((hostId) =>
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

    moveProjectToGroup: async (project, groupId, order) => {
      try {
        const repo = get().repos.find((candidate) => isSameRepoRow(candidate, project))
        const repoHostId = repo ? getRepoExecutionHostId(repo) : null
        const target = repoHostId ? ipcOrRuntimeTargetForHostId(repoHostId) : null
        if (!repo || !repoHostId || !target) {
          return false
        }
        if (groupId && !isProjectGroupJoinableFromCatalog(get().projectGroups, groupId, target)) {
          notifyProjectGroupOnOtherHost()
          return false
        }
        const moved =
          target.kind === 'local'
            ? await window.api.projectGroups.moveProject({
                projectId: repo.id,
                groupId,
                order,
                hostId: repoHostId
              })
            : (
                await callRuntimeRpc<{ repo: Repo | null }>(
                  target,
                  'projectGroup.moveProject',
                  // Why connectionId: the server's own twins differ only by their SSH target there.
                  { repo: repo.id, groupId, order, connectionId: repo.connectionId ?? null },
                  { timeoutMs: 15_000 }
                )
              ).repo
        if (!moved) {
          return false
        }
        const ownedMoved = adoptFromEndpoint(target, { kind: 'repo', row: moved })
        const movedHostId = getRepoExecutionHostId(ownedMoved)
        set((s) => {
          const nextRepos = s.repos.map((candidate) =>
            isSameRepoRow(candidate, repo) ? ownedMoved : candidate
          )
          return {
            repos: nextRepos,
            ...mergeProjectCompatibilityForHostRepoChange({
              previous: { projects: s.projects, projectHostSetups: s.projectHostSetups },
              nextRepos,
              hostId: movedHostId
            }),
            folderWorkspacePathStatuses: {}
          }
        })
        // Why: hosts store an unknown group id as "no group" and still return the row (#13699).
        if (groupId && (moved.projectGroupId ?? null) !== groupId) {
          notifyProjectGroupOnOtherHost()
          return false
        }
        return true
      } catch (err) {
        console.error('Failed to move repo to group:', err)
        return false
      }
    }
  }
}
