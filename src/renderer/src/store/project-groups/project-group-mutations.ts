import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import { selectProjectGroupRemovalTargets } from '../slices/project-group-removal-targets'
import {
  catalogOwnsHost,
  filterProjectGroupsForRepo,
  getProjectGroupCatalogHostId,
  getProjectGroupHostId,
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
import { getProjectSetupRuntimeTarget } from '../projects/project-host-routing'
import { claimHostCatalogFence } from '../host-catalog-fencing'

function upsertProjectGroupForOwner(
  projectGroups: readonly ProjectGroup[],
  ownedGroup: ProjectGroup
): ProjectGroup[] {
  const ownerHostId = getProjectGroupCatalogHostId(getProjectGroupHostId(ownedGroup))
  let inserted = false
  const next: ProjectGroup[] = []
  for (const group of projectGroups) {
    if (projectGroupMatchesOwnerHost(group, ownedGroup.id, ownerHostId)) {
      if (!inserted) {
        next.push(ownedGroup)
        inserted = true
      }
    } else {
      next.push(group)
    }
  }
  if (!inserted) {
    next.push(ownedGroup)
  }
  return next
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
    createProjectGroup: async (name, options) => {
      try {
        const target = options?.hostId
          ? getProjectSetupRuntimeTarget(options.hostId)
          : getActiveRuntimeTarget(get().settings)
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
        claimHostCatalogFence(get, 'project-groups', target)
        const ownedGroup = projectGroupWithFetchedOwner(group, target)
        set((s) => ({
          projectGroups: upsertProjectGroupForOwner(s.projectGroups, ownedGroup),
          folderWorkspacePathStatuses: {}
        }))
        return ownedGroup
      } catch (err) {
        console.error('Failed to create project group:', err)
        return null
      }
    },

    updateProjectGroup: async (groupId, updates, options) => {
      try {
        // Why: the sidebar lists groups from every host, so the mutation follows the group's owner, not the focused host.
        const target = getActiveRuntimeTarget(
          settingsForProjectGroupOwner(get(), groupId, options?.hostId)
        )
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
        claimHostCatalogFence(get, 'project-groups', target)
        const ownedGroup = projectGroupWithFetchedOwner(updated, target)
        set((s) => ({
          projectGroups: upsertProjectGroupForOwner(s.projectGroups, ownedGroup),
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
        const ownerHostId = resolveProjectGroupOwnerHostId(get(), groupId, options?.hostId)
        const target = getActiveRuntimeTarget(
          settingsForProjectGroupOwner(get(), groupId, options?.hostId)
        )
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
        claimHostCatalogFence(get, 'project-groups', target)
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
      // Why: the group's catalog can hold rows from several hosts (a local catalog also owns SSH rows),
      // so each project is removed on its own host rather than on the group's.
      const findOwnedProjects = (projectId: string): Repo[] =>
        get().repos.filter(
          (repo) =>
            repo.id === projectId &&
            (!ownerHostId || catalogOwnsHost(ownerHostId, getRepoExecutionHostId(repo)))
        )
      for (const projectId of targets.projectIds) {
        const ownedProjects = findOwnedProjects(projectId)
        const projectHostId =
          ownedProjects.length === 1 ? getRepoExecutionHostId(ownedProjects[0]) : undefined
        try {
          if (ownedProjects.length > 0) {
            await get().removeProject(projectId, { hostId: projectHostId })
          }
        } catch (err) {
          console.error('Failed to remove contained project:', err)
        }
        const stillExists = findOwnedProjects(projectId).length > 0
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
        const state = get()
        const ownerRepo = findRepoForHost(state.repos, projectId, {
          settings: state.settings,
          hostId: options?.hostId
        })
        if (!ownerRepo) {
          return false
        }
        if (
          groupId &&
          !filterProjectGroupsForRepo(state.projectGroups, ownerRepo).some(
            (group) => group.id === groupId
          )
        ) {
          return false
        }
        const target = getActiveRuntimeTarget(
          settingsForRepoOwner(state, projectId, getRepoExecutionHostId(ownerRepo))
        )
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
