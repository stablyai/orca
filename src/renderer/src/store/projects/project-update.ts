import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { Project } from '../../../../shared/project-types'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { notifyInstalledAgentSkillsChanged } from '@/hooks/installed-agent-skill-discovery'
import type { RepoSlice } from '../repos/repo-state'
import { getProjectUpdateRuntimeTarget } from './project-host-routing'
import { mergeUpdatedProjectCompatibilityProject } from './project-compatibility-core'

export function createProjectUpdateActions(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<RepoSlice, 'updateProject'> {
  return {
    updateProject: async (projectId, updates) => {
      try {
        const target = getProjectUpdateRuntimeTarget(get(), projectId)
        const updatedProject =
          target.kind === 'local'
            ? await window.api.projects.update({ projectId, updates })
            : (
                await callRuntimeRpc<{ project: Project }>(
                  target,
                  'project.update',
                  { projectId, updates },
                  { timeoutMs: 15_000 }
                )
              ).project
        if (!updatedProject) {
          return false
        }
        const runtimePreferenceChanged = 'localWindowsRuntimePreference' in updates
        set((state) => ({
          projects: state.projects.map((project) =>
            project.id === projectId
              ? mergeUpdatedProjectCompatibilityProject(project, updatedProject, updates)
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
