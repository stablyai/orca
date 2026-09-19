import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { RepoSlice } from '../repos/repo-state'
import { getProjectGroupHostId } from '../slices/project-group-owner-routing'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
import { projectGroupWithFetchedOwner } from './project-group-owner-stamping'

export function createProjectGroupAction(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): RepoSlice['createProjectGroup'] {
  return async (name) => {
    try {
      const target = getActiveRuntimeTarget(get().settings)
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
      const ownedGroup = projectGroupWithFetchedOwner(group, target)
      const ownerHostId = getProjectGroupHostId(ownedGroup)
      set((s) => {
        // An overlapping catalog refresh may have already inserted a newer copy.
        if (
          s.projectGroups.some(
            (existing) =>
              existing.id === ownedGroup.id && getProjectGroupHostId(existing) === ownerHostId
          )
        ) {
          return s
        }
        return {
          projectGroups: [...s.projectGroups, ownedGroup],
          folderWorkspacePathStatuses: {}
        }
      })
      return ownedGroup
    } catch (err) {
      console.error('Failed to create project group:', err)
      return null
    }
  }
}
