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
import { normalizeProjectRow } from '../../../../shared/project-catalog-row-normalization'
import { getProjectHostSetupProjectionFromState } from '../project-host-setup-selector'
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
        const targetsByKey = new Map<
          string,
          { id: ExecutionHostId; target: ReturnType<typeof getProjectSetupRuntimeTarget> }
        >()
        for (const id of hostIds) {
          const target = getProjectSetupRuntimeTarget(id)
          const key = target.kind === 'local' ? 'local' : target.environmentId
          if (!targetsByKey.has(key) || id === hostId) {
            targetsByKey.set(key, { id, target })
          }
        }
        const targets = [...targetsByKey.values()]
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
        for (const { id, target } of targets.sort(
          (a, b) => Number(a.target.kind !== 'local') - Number(b.target.kind !== 'local')
        )) {
          const owner = owners.find((setup) => setup.hostId === id)
          const targetProjectId =
            state.projectHostSetups.find(
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
          const updated = normalizeProjectRow(result)
          set((state) => ({
            projects: state.projects.map((project) =>
              project.id === targetProjectId
                ? mergeUpdatedProjectCompatibilityProject(project, updated, targetUpdates)
                : project
            ),
            folderWorkspacePathStatuses: {}
          }))
          if ('localWindowsRuntimePreference' in targetUpdates) {
            get().clearLocalDetectedAgents()
            notifyInstalledAgentSkillsChanged()
          }
        }
        return completedHosts > 0
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
