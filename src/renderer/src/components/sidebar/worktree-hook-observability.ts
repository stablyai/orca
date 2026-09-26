import type { AppState } from '@/store/types'
import { getConnectionIdFromState } from '@/lib/connection-owner-resolution'
import { getIndexedWorktreeById } from '@/store/worktree-repo-index'
import {
  isWorktreeAgentStatusUnverifiable,
  localHookConfigOwnsWorktree
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
  if (!state.settings || state.settings.agentStatusHooksEnabled === false) {
    return false
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
    return false
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
  if (liveAgents.length === 0) {
    return false
  }
  return isWorktreeAgentStatusUnverifiable({
    liveAgents,
    installStateByTarget: state.agentHookInstallStateByTarget,
    connectionId,
    worktreePath,
    hasActiveHookEvidence: evidence.hasPermission || evidence.hasLiveWorking
  })
}

function paneUsesNativeHookConfig(
  state: WorktreeHookObservabilityState,
  tab: WorktreeHookObservabilityState['tabsByWorktree'][string][number],
  ptyId: string
): boolean {
  try {
    // This resolver mirrors the pane's spawn host and is agent-agnostic despite its account name.
    return resolveCodexPaneSelectionLaneKey({ state, tab, ptyId }) === 'host'
  } catch {
    return false
  }
}
