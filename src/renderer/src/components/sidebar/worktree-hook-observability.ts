import type { AppState } from '@/store/types'
import { getConnectionIdFromState } from '@/lib/connection-owner-resolution'
import { getIndexedWorktreeById } from '@/store/worktree-repo-index'
import {
  isWorktreeAgentStatusUnverifiable,
  localHookConfigOwnsWorktree,
  type WorktreeAgentObservabilityInput
} from '@/lib/agent-status-observability'
import { resolveCodexPaneSelectionLaneKey } from '@/lib/codex-pane-selection-lane'
import { isManagedAgentHookTarget } from '../../../../shared/managed-agent-hook-targets'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { normalizeDisabledTuiAgents } from '../../../../shared/tui-agent-selection'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'

export type WorktreeHookObservabilityState = Pick<
  AppState,
  | 'activeRepoId'
  | 'activeWorktreeId'
  | 'agentHookInstallStateByTarget'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'projects'
  | 'ptyIdsByTabId'
  | 'repos'
  | 'settings'
  | 'tabsByWorktree'
  | 'worktreesByRepo'
>

type AgentHookInstallStatusConsumerState = Omit<
  WorktreeHookObservabilityState,
  'agentHookInstallStateByTarget'
>

type HookEvidence = {
  hasPermission: boolean
  hasLiveWorking: boolean
}

/** Retained outcomes cannot prove hooks still work after a config rewrite. */
export function selectWorktreeHooksUnverifiable(
  state: WorktreeHookObservabilityState,
  worktreeId: string,
  evidence: HookEvidence
): boolean {
  const consumers = getWorktreeHookConsumers(state, worktreeId)
  if (!consumers) {
    return false
  }
  return isWorktreeAgentStatusUnverifiable({
    ...consumers,
    installStateByTarget: state.agentHookInstallStateByTarget,
    hasActiveHookEvidence: evidence.hasPermission || evidence.hasLiveWorking
  })
}

export function canSkipAgentHookInstallStatusConsumerSync(
  state: AgentHookInstallStatusConsumerState,
  previousState: AgentHookInstallStatusConsumerState
): boolean {
  return (
    state.activeRepoId === previousState.activeRepoId &&
    state.activeWorktreeId === previousState.activeWorktreeId &&
    state.folderWorkspaces === previousState.folderWorkspaces &&
    state.projectGroups === previousState.projectGroups &&
    state.projects === previousState.projects &&
    state.ptyIdsByTabId === previousState.ptyIdsByTabId &&
    state.repos === previousState.repos &&
    state.settings === previousState.settings &&
    state.tabsByWorktree === previousState.tabsByWorktree &&
    state.worktreesByRepo === previousState.worktreesByRepo
  )
}

export function selectHasAgentHookInstallStatusConsumer(
  state: AgentHookInstallStatusConsumerState
): boolean {
  return Object.keys(state.tabsByWorktree).some(
    (worktreeId) => getWorktreeHookConsumers(state, worktreeId) !== null
  )
}

function getWorktreeHookConsumers(
  state: AgentHookInstallStatusConsumerState,
  worktreeId: string
): Pick<WorktreeAgentObservabilityInput, 'liveAgents' | 'connectionId' | 'worktreePath'> | null {
  if (!state.settings || state.settings.agentStatusHooksEnabled === false) {
    return null
  }
  const disabledAgents = new Set(normalizeDisabledTuiAgents(state.settings.disabledTuiAgents))
  const workspaceScope = parseWorkspaceKey(worktreeId)
  const worktreePath =
    workspaceScope?.type === 'folder'
      ? state.folderWorkspaces.find(
          (workspace) => workspace.id === workspaceScope.folderWorkspaceId
        )?.folderPath
      : getIndexedWorktreeById(
          state.worktreesByRepo,
          workspaceScope?.type === 'worktree' ? workspaceScope.worktreeId : worktreeId
        )?.path
  const connectionId = getConnectionIdFromState(state, worktreeId)
  if (!localHookConfigOwnsWorktree(connectionId, worktreePath)) {
    return null
  }
  const liveAgents: (TuiAgent | undefined)[] = []
  for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
    if (!isManagedAgentHookTarget(tab.launchAgent) || disabledAgents.has(tab.launchAgent)) {
      continue
    }
    const ptyIds = state.ptyIdsByTabId[tab.id] ?? []
    if (ptyIds.length > 0 && ptyIds.every((ptyId) => paneUsesNativeHookConfig(state, tab, ptyId))) {
      liveAgents.push(tab.launchAgent)
    }
  }
  return liveAgents.length > 0 ? { liveAgents, connectionId, worktreePath } : null
}

function paneUsesNativeHookConfig(
  state: AgentHookInstallStatusConsumerState,
  tab: AgentHookInstallStatusConsumerState['tabsByWorktree'][string][number],
  ptyId: string
): boolean {
  try {
    // This resolver mirrors the pane's spawn host and is agent-agnostic despite its account name.
    return resolveCodexPaneSelectionLaneKey({ state, tab, ptyId }) === 'host'
  } catch {
    return false
  }
}
