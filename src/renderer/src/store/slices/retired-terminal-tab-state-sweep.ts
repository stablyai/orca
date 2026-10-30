import { removePaneKeys } from './agent-status/agent-status-pane-keyed-records'
import type { AppState } from '../types'
import { forgetAgentHibernationTabOutput } from '@/lib/agent-hibernation-output-activity'
import { forgetForegroundTerminalTabs } from '@/lib/foreground-terminal-tabs'
import { forgetAgentStartupDeliveriesForTabs } from '@/lib/agent-startup-delivery-guards'
// Use store-free registry to avoid a slice-evaluation cycle through terminal-parked-tab-watchers.
import { retireParkedTerminalTab } from '@/components/terminal-pane/terminal-parked-watcher-registry'
import { forgetNativeChatPromptDismissalsForTab } from '@/components/native-chat/native-chat-prompt-dismissals'
import { retireAgentPaneAuthorityAliasesByOwnerTab } from './agent-pane-authority'
import './agent-status/agent-status'
import {
  buildAgentStatusTabPrefixDropPatch,
  type AgentStatusTabPrefixDropState
} from './agent-status/agent-status-drop-reducer'
import { buildPaneForegroundAgentTabPrefixClearPatch } from './pane-foreground-agent'

export type RetiredTerminalTabSweepActions = Pick<
  AppState,
  'dropAgentStatusByTabPrefix' | 'clearPaneForegroundAgentByTabPrefix'
>

/** Narrow state lets non-store callers supply their own view. */
export type RetiredTerminalTabSweepState = AgentStatusTabPrefixDropState &
  Pick<AppState, 'paneForegroundAgentByPaneKey'>

/** Shared retirement sweep prevents divergent cleanup (STA-4593); not full closeTab parity: callers still own other pane maps. Run after tabsByWorktree removal so completed-orphan detection works. */
export function sweepRetiredTerminalTabState(
  actions: RetiredTerminalTabSweepActions,
  tabId: string,
  worktreeId?: string | null
): void {
  // Retirement has no earlier hook; closeTab revokes these before provider teardown to fence PTY exit.
  retireParkedTerminalTab(tabId)
  // Worktree scope sweeps Pi’s completed missing-tab rows while preserving active pre-render children.
  actions.dropAgentStatusByTabPrefix(tabId, worktreeId ? { worktreeId } : undefined)
  actions.clearPaneForegroundAgentByTabPrefix(tabId)
  forgetAgentHibernationTabOutput(tabId)
  forgetNativeChatPromptDismissalsForTab(tabId)
  forgetForegroundTerminalTabs([tabId])
  forgetAgentStartupDeliveriesForTabs([tabId])
}

/** Build a sweep patch from state already excluding retired tabs; module registries are also mutated. */
export function buildRetiredTerminalTabStateSweepPatch(
  state: RetiredTerminalTabSweepState,
  tabIds: readonly string[],
  worktreeId?: string | null,
  opts?: {
    preserveActivityClearedState?: boolean
    paneKeys?: ReadonlySet<string>
    changedAgentPaneKeys?: Set<string>
  }
): Partial<RetiredTerminalTabSweepState> | null {
  if (tabIds.length === 0) {
    return null
  }
  // Registry effects are idempotent for retired IDs, but still run if the caller discards this patch.
  let swept: RetiredTerminalTabSweepState = state
  for (const tabId of tabIds) {
    if (!opts?.paneKeys) {
      retireParkedTerminalTab(tabId)
    }
    const { patch, removedPaneKeys } = buildAgentStatusTabPrefixDropPatch(
      swept,
      tabId,
      opts?.paneKeys ? [] : retireAgentPaneAuthorityAliasesByOwnerTab(tabId),
      {
        ...(worktreeId ? { worktreeId } : {}),
        ...(opts?.paneKeys ? { paneKeys: opts.paneKeys } : {}),
        ...(opts?.preserveActivityClearedState ? { preserveActivityClearedState: true } : {})
      }
    )
    for (const key of removedPaneKeys) {
      opts?.changedAgentPaneKeys?.add(key)
    }
    const foreground = opts?.paneKeys
      ? {
          paneForegroundAgentByPaneKey: removePaneKeys(
            swept.paneForegroundAgentByPaneKey,
            opts.paneKeys
          )
        }
      : buildPaneForegroundAgentTabPrefixClearPatch(swept.paneForegroundAgentByPaneKey, [
          `${tabId}:`
        ])
    swept = { ...swept, ...patch, ...foreground }
    if (!opts?.paneKeys) {
      forgetAgentHibernationTabOutput(tabId)
      forgetNativeChatPromptDismissalsForTab(tabId)
    }
  }
  if (!opts?.paneKeys) {
    forgetForegroundTerminalTabs(tabIds)
    forgetAgentStartupDeliveriesForTabs(tabIds)
  }
  const changed: Record<string, unknown> = {}
  for (const key of Object.keys(swept) as (keyof RetiredTerminalTabSweepState)[]) {
    if (!Object.is(swept[key], state[key])) {
      changed[key] = swept[key]
    }
  }
  return Object.keys(changed).length === 0
    ? null
    : (changed as Partial<RetiredTerminalTabSweepState>)
}
