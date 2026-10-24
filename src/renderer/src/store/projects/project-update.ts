import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { Project } from '../../../../shared/project-types'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { notifyInstalledAgentSkillsChanged } from '@/hooks/installed-agent-skill-discovery'
import type { RepoSlice } from '../repos/repo-state'
import { getProjectSetupRuntimeTarget } from './project-host-routing'
import { mergeUpdatedProjectCompatibilityProject } from '../../../../shared/project-compatibility-merge'
import { getProjectHostSetupProjectionFromState } from '../project-host-setup-selector'
import { normalizeProjectRow } from '../../../../shared/project-catalog-row-normalization'

export function createProjectUpdateActions(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<RepoSlice, 'updateProject'> {
  return {
    updateProject: async (projectId, updates, hostId) => {
      try {
        // Why: the caller names the host whose project row it edits; focus never picks it.
        const state = get()
        const owner = getProjectHostSetupProjectionFromState(state).setups.find(
          (setup) => setup.projectId === projectId && setup.hostId === hostId
        )
        const endpointProjectId =
          state.endpointProjectHostSetups.find(
            (setup) => owner && setup.id === owner.id && setup.hostId === owner.hostId
          )?.projectId ?? projectId
        const target = getProjectSetupRuntimeTarget(hostId)
        const updatedProject =
          target.kind === 'local'
            ? await window.api.projects.update({ projectId: endpointProjectId, updates })
            : (
                await callRuntimeRpc<{ project: Project }>(
                  target,
                  'project.update',
                  { projectId: endpointProjectId, updates },
                  { timeoutMs: 15_000 }
                )
              ).project
        if (!updatedProject) {
          return false
        }
        // Why: the merge spreads updatedProject.sourceRepoIds, which throws if the host sent a non-array.
        const normalizedProject = normalizeProjectRow(updatedProject)
        const runtimePreferenceChanged = 'localWindowsRuntimePreference' in updates
        set((state) => ({
          endpointProjects: state.endpointProjects.map((project) =>
            project.id === endpointProjectId
              ? mergeUpdatedProjectCompatibilityProject(project, normalizedProject, updates)
              : project
          ),
          folderWorkspacePathStatuses: {}
        }))
        if (runtimePreferenceChanged) {
          get().clearLocalDetectedAgents()
          notifyInstalledAgentSkillsChanged()
        }
        return true
      } catch (err) {
        console.error('Failed to update project:', err)
        return false
      }
    }
  }
}
