import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { worktreeUsesRemoteConnection } from '@/store/terminals/terminal-workspace-routing'
import { hasRemoteRuntimePtyForTab } from './tab-agent-remote-pty-selector'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import {
  resolveFocusedCompletedTabAgent,
  resolveFocusedRetainedTabAgent,
  resolveFocusedTabAgent,
  resolveSiblingCompletedTabAgent,
  resolveSiblingRetainedTabAgent,
  resolveSiblingTabAgent
} from './tab-agent'
import type { TuiAgent } from '../../../shared/tui-agent'

/**
 * Everything `useTabAgent` reads from the store for one tab. Every field is a
 * primitive or the store's own action, so the bundle below is shallow-comparable
 * AND keeps the render isolation thirteen separate selectors used to buy: an
 * agent-status write that does not move one of these values rerenders nothing.
 */
export type TabAgentStoreSignals = {
  focusedHookAgent: TuiAgent | null
  siblingHookAgent: TuiAgent | null
  focusedCompletedHookAgent: TuiAgent | null
  siblingCompletedHookAgent: TuiAgent | null
  /** Recognized foreground process in the focused pane (local panes only). */
  processAgent: TuiAgent | null
  /** OSC 133;D: the focused pane's foreground is proven back at the shell. */
  processShellForeground: boolean
  sleepingSessionAgent: TuiAgent | null
  /** Focused pane's PTY; only used to reset per-process-generation signals on respawn. */
  ptyId: string | null
  /** Whether a completed row can be attributed to the focused pane at all. */
  completedHookScopeKnown: boolean
  /** Remote worktree or a paired runtime PTY — both suppress local-only exit evidence. */
  isRemoteLike: boolean
  clearTabLaunchAgent: AppState['clearTabLaunchAgent']
}

type TabAgentSignalState = Pick<
  AppState,
  | 'agentStatusByPaneKey'
  | 'retainedAgentsByPaneKey'
  | 'terminalLayoutsByTabId'
  | 'ptyIdsByTabId'
  | 'paneForegroundAgentByPaneKey'
  | 'sleepingAgentSessionsByPaneKey'
  | 'clearTabLaunchAgent'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'repos'
  | 'worktreesByRepo'
>

/**
 * Why one selector and not thirteen: zustand visits every listener on every
 * publication, so a burst costs `events x listeners x selector work`
 * (docs/reference/renderer-agent-status-performance.md) — and this hook's listener
 * count is multiplied by every mounted tab and card. Resolving in one pass also
 * shares the layout lookup and the focused pane key the old selectors each redid.
 */
export function selectTabAgentStoreSignals(
  state: TabAgentSignalState,
  tabId: string,
  worktreeId: string
): TabAgentStoreSignals {
  const layout = state.terminalLayoutsByTabId[tabId]
  const activeLeafId = layout?.activeLeafId
  const focusedLeafId = activeLeafId && isTerminalLeafId(activeLeafId) ? activeLeafId : null
  const focusedPaneKey = focusedLeafId ? makePaneKey(tabId, focusedLeafId) : null
  const foreground = focusedPaneKey ? state.paneForegroundAgentByPaneKey[focusedPaneKey] : undefined
  const tabPtyIds = state.ptyIdsByTabId[tabId] ?? []
  const leafPty = activeLeafId ? layout?.ptyIdsByLeafId?.[activeLeafId] : undefined

  return {
    focusedHookAgent: resolveFocusedTabAgent(state.agentStatusByPaneKey, layout, tabId),
    siblingHookAgent: resolveSiblingTabAgent(state.agentStatusByPaneKey, layout, tabId),
    focusedCompletedHookAgent:
      resolveFocusedCompletedTabAgent(state.agentStatusByPaneKey, layout, tabId) ??
      resolveFocusedRetainedTabAgent(state.retainedAgentsByPaneKey, layout, tabId),
    siblingCompletedHookAgent:
      resolveSiblingCompletedTabAgent(state.agentStatusByPaneKey, layout, tabId) ??
      resolveSiblingRetainedTabAgent(state.retainedAgentsByPaneKey, layout, tabId),
    processAgent: foreground?.agent ?? null,
    processShellForeground: Boolean(foreground?.shellForeground),
    sleepingSessionAgent: focusedPaneKey
      ? (state.sleepingAgentSessionsByPaneKey[focusedPaneKey]?.agent ?? null)
      : null,
    ptyId: leafPty ? leafPty : tabPtyIds.length === 1 ? tabPtyIds[0]! : null,
    // Why: with no layout to place a completed row, only a single-pane tab may treat it as focused-pane exit evidence.
    completedHookScopeKnown: focusedLeafId !== null || tabPtyIds.length <= 1,
    isRemoteLike:
      worktreeUsesRemoteConnection(state, worktreeId) ||
      hasRemoteRuntimePtyForTab(state.ptyIdsByTabId[tabId], layout?.ptyIdsByLeafId),
    clearTabLaunchAgent: state.clearTabLaunchAgent
  }
}

export function useTabAgentStoreSignals(tabId: string, worktreeId: string): TabAgentStoreSignals {
  return useAppStore(useShallow((s) => selectTabAgentStoreSignals(s, tabId, worktreeId)))
}
