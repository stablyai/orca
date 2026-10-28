import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { Project } from '../../../../shared/project-types'
import { PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY } from '../../../../shared/agent-launch-runtime-capability'
import {
  assertRuntimeEnvironmentCapability,
  callRuntimeRpc
} from '../../runtime/runtime-rpc-client'
import { notifyInstalledAgentSkillsChanged } from '@/hooks/installed-agent-skill-discovery'
import type { RepoSlice } from '../repos/repo-state'
import { getProjectSetupRuntimeTarget } from './project-host-routing'
import { mergeUpdatedProjectCompatibilityProject } from '../../../../shared/project-compatibility-merge'
import { getProjectHostSetupProjectionFromState } from '../project-host-setup-selector'
import { normalizeProjectRow } from '../../../../shared/project-catalog-row-normalization'
import type { ExecutionHostId } from '../../../../shared/execution-host'

export function createProjectUpdateActions(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<RepoSlice, 'updateProject'> {
  return {
    updateProject: async (projectId, updates, hostId) => {
      const updatingDefault = 'defaultTuiAgent' in updates
      let completedHosts = 0
      try {
        // Why: the caller names the host whose project row it edits; focus never picks it.
        const state = get()
        const owners = getProjectHostSetupProjectionFromState(state).setups.filter(
          (setup) => setup.projectId === projectId
        )
        const hostIds: ExecutionHostId[] =
          updatingDefault && owners.length
            ? [...new Set(owners.map((setup) => setup.hostId))]
            : [hostId]
        const targets = [
          ...new Map(
            hostIds.map((id) => {
              const target = getProjectSetupRuntimeTarget(id)
              return [
                target.kind === 'local' ? 'local' : target.environmentId,
                { id, target }
              ] as const
            })
          ).values()
        ]
        if (updatingDefault) {
          for (const { target } of targets) {
            if (target.kind === 'environment') {
              await assertRuntimeEnvironmentCapability(
                target.environmentId,
                PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY,
                'The target Orca host cannot save a project default agent. Update Orca on that host and try again.',
                15_000
              )
            }
          }
        }
        const acknowledged = new Map<string, Project>()
        for (const { id, target } of targets.sort(
          (a, b) => Number(a.target.kind !== 'local') - Number(b.target.kind !== 'local')
        )) {
          const owner = owners.find((setup) => setup.hostId === id)
          const targetProjectId =
            state.endpointProjectHostSetups.find(
              (setup) => owner && setup.id === owner.id && setup.hostId === owner.hostId
            )?.projectId ?? projectId
          const targetUpdates =
            updatingDefault && id !== hostId
              ? { defaultTuiAgent: updates.defaultTuiAgent }
              : updates
          const result =
            target.kind === 'local'
              ? await window.api.projects.update({
                  projectId: targetProjectId,
                  updates: targetUpdates
                })
              : (
                  await callRuntimeRpc<{ project: Project }>(
                    target,
                    'project.update',
                    { projectId: targetProjectId, updates: targetUpdates },
                    { timeoutMs: 15_000 }
                  )
                ).project
          if (!result || (updatingDefault && result.defaultTuiAgent !== updates.defaultTuiAgent)) {
            throw new Error(
              'Project default agent was not saved on the target host. Update Orca on that host and try again.'
            )
          }
          completedHosts += 1
          // Why: distinct hosts can advertise different endpoint project IDs for one canonical project.
          acknowledged.set(targetProjectId, normalizeProjectRow(result))
        }
        if (acknowledged.size === 0) {
          return false
        }
        const runtimePreferenceChanged = 'localWindowsRuntimePreference' in updates
        set((state) => ({
          endpointProjects: state.endpointProjects.map((project) => {
            const updated = acknowledged.get(project.id)
            return updated
              ? mergeUpdatedProjectCompatibilityProject(project, updated, updates)
              : project
          }),
          folderWorkspacePathStatuses: {}
        }))
        if (runtimePreferenceChanged) {
          get().clearLocalDetectedAgents()
          notifyInstalledAgentSkillsChanged()
        }
        return true
      } catch (err) {
        console.error('Failed to update project:', err)
        if (updatingDefault && completedHosts > 0) {
          throw new Error(
            'Project default agent was saved on some hosts but not others. Retry the setting to finish saving it on every host.'
          )
        }
        return false
      }
    }
  }
}
