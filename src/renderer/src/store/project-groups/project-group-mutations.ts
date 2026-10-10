import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import { selectProjectGroupRemovalTargets } from '../slices/project-group-removal-targets'
import {
  projectGroupMatchesOwnerHost,
  resolveProjectGroupOwnerHostId,
  settingsForProjectGroupOwner
} from '../slices/project-group-owner-routing'
import { findRepoForHost, repoMatchesHostIdentity } from '../slices/repo-host-identity'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { ProjectRemovalFailure, RepoSlice } from '../repos/repo-state'
import { mergeProjectCompatibilityForHostRepoChange } from '../repos/repo-catalog-identity'
import { applyProjectGroupDeleteCascade } from './project-group-removal-state'
import { repoWithFetchedOwner, settingsForRepoOwner } from '../repos/owner-routing'
import { projectGroupWithFetchedOwner } from './project-group-owner-stamping'
import { createProjectGroupAction } from './project-group-create'
import { getCatalogOwnerHostId } from '@/lib/worktree-runtime-owner-index'
import {
  getProjectGroupRuntimeTarget,
  getProjectGroupTargetHostId,
  resolveProjectGroupMutationTarget
} from './project-group-mutation-routing'

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
    createProjectGroup: createProjectGroupAction(set, get),

    updateProjectGroup: async (groupId, updates, options) => {
      try {
        // Why: the sidebar lists groups from every host, so the mutation follows the group's owner, not the focused host.
        const route = resolveProjectGroupMutationTarget(get(), groupId, options)
        if (!route) {
          return false
        }
        const { target, ownerHostId } = route
        const updated =
          target.kind === 'local'
            ? await window.api.projectGroups.update({ groupId, updates })
            : (
                await callRuntimeRpc<{ group: ProjectGroup | null }>(
                  target,
                  'projectGroup.update',
                  { groupId, updates },
                  { timeoutMs: 15_000 }
                )
              ).group
        if (!updated) {
          return false
        }
        const ownedGroup = projectGroupWithFetchedOwner(updated, target)
        set((s) => ({
          projectGroups: s.projectGroups.map((group) =>
            projectGroupMatchesOwnerHost(group, groupId, ownerHostId) ? ownedGroup : group
          ),
          folderWorkspacePathStatuses: {}
        }))
        return true
      } catch (err) {
        console.error('Failed to update project group:', err)
        return false
      }
    },

    deleteProjectGroup: async (groupId, options) => {
      try {
        // Why: deletion targets the group's owner host (see updateProjectGroup); focus may be elsewhere.
        const route = resolveProjectGroupMutationTarget(get(), groupId, options)
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
      const requestedHostId = options.executionHostId ?? options.hostId
      if (
        requestedHostId &&
        !get().projectGroups.some(
          (group) => group.id === groupId && getCatalogOwnerHostId(group) === requestedHostId
        )
      ) {
        return {
          status: 'missing-group',
          groupId,
          requestedProjectIds: [],
          removedProjectIds: [],
          failedProjectRemovals: []
        }
      }
      const executionTarget = options.executionHostId
        ? getProjectGroupRuntimeTarget(get(), groupId, options.executionHostId)
        : null
      if (options.executionHostId && !executionTarget) {
        return {
          status: 'group-delete-failed',
          groupId,
          requestedProjectIds: [],
          removedProjectIds: [],
          failedProjectRemovals: []
        }
      }
      const target =
        executionTarget?.target ??
        getActiveRuntimeTarget(settingsForProjectGroupOwner(get(), groupId, requestedHostId))
      const ownerHostId =
        executionTarget?.ownerHostId ??
        resolveProjectGroupOwnerHostId(get(), groupId, requestedHostId) ??
        getProjectGroupTargetHostId(target)
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
          requestedProjectIds: [],
          removedProjectIds: [],
          failedProjectRemovals: []
        }
      }

      const deleted = await get().deleteProjectGroup(
        groupId,
        options.executionHostId ? { executionHostId: ownerHostId } : { hostId: ownerHostId }
      )
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
      // Why: members were captured before the cascade cleared membership; a same-id row on another
      // host outside the group must survive, so each member row is removed on its own host.
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
            await get().removeProject(projectId, { hostId })
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

    moveProjectToGroup: async (projectId, groupId, order, options) => {
      try {
        const resolvedGroup = groupId
          ? getProjectGroupRuntimeTarget(get(), groupId, options?.executionHostId)
          : null
        if (groupId && !resolvedGroup) {
          return false
        }
        // Why: the source repo and destination group may belong to different hosts.
        const sourceRepo = findRepoForHost(get().repos, projectId, {
          settings: get().settings,
          hostId: options?.executionHostId
        })
        if (!sourceRepo) {
          return false
        }
        const repoHostId = getRepoExecutionHostId(sourceRepo)
        const target =
          resolvedGroup?.target ??
          getActiveRuntimeTarget(settingsForRepoOwner(get(), projectId, repoHostId))
        const moved =
          target.kind === 'local'
            ? await window.api.projectGroups.moveProject({
                projectId,
                groupId,
                order
              })
            : (
                await callRuntimeRpc<{ repo: Repo | null }>(
                  target,
                  'projectGroup.moveProject',
                  { repo: projectId, groupId, order },
                  { timeoutMs: 15_000 }
                )
              ).repo
        if (!moved) {
          return false
        }
        const ownedMoved = repoWithFetchedOwner(moved, target)
        const movedHostId = getRepoExecutionHostId(ownedMoved)
        set((s) => {
          const nextRepos = s.repos.map((repo) =>
            repoMatchesHostIdentity(repo, projectId, movedHostId) ? ownedMoved : repo
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
        return true
      } catch (err) {
        console.error('Failed to move repo to group:', err)
        return false
      }
    }
  }
}
