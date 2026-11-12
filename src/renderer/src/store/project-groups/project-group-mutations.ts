import { selectFolderWorkspaces } from '../workspaces/catalog/workspace-record-fields'
import { createProjectGroupMoveAction } from './project-group-project-move'
import { collectProjectGroupArchiveDecisions } from './project-group-archive-decisions'
import { projectGroupHookOwner } from '../../../../shared/workspace-hook-owner'
import { PROJECT_GROUP_FOLDER_SETUP_RUNTIME_CAPABILITY } from '../../../../shared/worktree-runtime-capabilities'
import { resolveFolderSetupSupported } from '@/lib/workspace/creation/setup/folder-setup-support'
import { projectGroupDeleteTimeoutMs } from '../../../../shared/project-group-removal'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
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
import { ipcOrRuntimeTargetForHostId } from '../../runtime/rpc/targets/runtime-client-target'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { runtimeEnvironmentSupportsCapability } from '../../runtime/rpc/compatibility/runtime-capability-proof'
import type { ProjectRemovalFailure, RepoSlice } from '../repos/repo-state'
import { applyProjectGroupDeleteCascade } from './project-group-removal-state'
import { adoptFromEndpoint } from '../host-catalog/endpoint-catalog-adoption'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

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
        const ownerHostId = resolveProjectGroupOwnerHostId(get(), groupId, options?.hostId)
        const target = runtimeTargetForProjectGroupOwner(get(), groupId, options?.hostId)
        if (!target) {
          return false
        }
        const group = get().projectGroups.find(
          (entry) => entry.id === groupId && getRepoExecutionHostId(entry) === ownerHostId
        )
        const supported =
          group &&
          (target.kind === 'environment'
            ? await runtimeEnvironmentSupportsCapability(
                target.environmentId,
                PROJECT_GROUP_FOLDER_SETUP_RUNTIME_CAPABILITY
              )
            : await resolveFolderSetupSupported(
                projectGroupHookOwner(group),
                PROJECT_GROUP_FOLDER_SETUP_RUNTIME_CAPABILITY
              ))
        const folders =
          supported && ownerHostId && target.kind === 'environment'
            ? selectFolderWorkspaces(
                await callRuntimeRpc<{ folderWorkspaces: FolderWorkspace[] }>(
                  target,
                  'folderWorkspace.list'
                )
              ).map((row) =>
                adoptFromEndpoint(target, {
                  kind: 'folderWorkspace',
                  row,
                  resolveOwnHostId: () => ownerHostId
                })
              )
            : selectFolderWorkspaces(get())
        const archive =
          supported && ownerHostId
            ? await collectProjectGroupArchiveDecisions(get, groupId, ownerHostId, folders)
            : undefined
        const request = {
          groupId,
          ...(archive ? { archiveDecisions: archive.archiveDecisions } : {})
        }
        const deleted =
          target.kind === 'local'
            ? await window.api.projectGroups.delete(request)
            : (
                await callRuntimeRpc<{ deleted: boolean }>(target, 'projectGroup.delete', request, {
                  timeoutMs: archive ? projectGroupDeleteTimeoutMs(archive.workspaceCount) : 15_000
                })
              ).deleted
        if (!deleted) {
          return false
        }
        set((s) => applyProjectGroupDeleteCascade(s, groupId, ownerHostId))
        return true
      } catch (err) {
        console.error('Failed to delete project group:', err)
        toast.error(
          translate(
            'settings.groupHooks.removalUnconfirmed',
            'Group removal could not be confirmed. Refresh projects to check its status.'
          )
        )
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

    moveProjectToGroup: createProjectGroupMoveAction(set, get)
  }
}
