import {
  afterPurgeAcceptance,
  preparePurgeOwnership
} from './worktrees/teardown/worktree-purge-preparation'
import {
  prepareAgentHibernationOutputRemoval,
  forgetAgentHibernationTabOutput
} from '@/lib/agent-hibernation-output-activity'
import {
  prepareAgentStartupDeliveriesRemoval,
  forgetAgentStartupDeliveriesForTabs
} from '@/lib/agent-startup-delivery-guards'
import { removePaneKeys } from './agent-status-pane-keyed-records'
import type { AppState } from '../types'

import { forgetForegroundTerminalTabs } from '@/lib/foreground-terminal-tabs'

// Use store-free registry to avoid a slice-evaluation cycle through terminal-parked-tab-watchers.
import { retireParkedTerminalTab } from '@/components/terminal-pane/terminal-parked-watcher-registry'
import { forgetNativeChatPromptDismissalsForTab } from '@/components/native-chat/native-chat-prompt-dismissals'
import { findAgentStatusOwner } from '../agent-status-commit'
import {
  buildAgentStatusTabPrefixDropPatch,
  type AgentStatusTabPrefixDropState
} from './agent-status'
import { buildPaneForegroundAgentTabPrefixClearPatch } from './pane-foreground-agent'

export type RetiredTerminalTabSweepActions = Pick<
  AppState,
  'dropAgentStatusByTabPrefix' | 'clearPaneForegroundAgentByTabPrefix'
>

/** Narrow state lets non-store callers supply their own view. */
export type RetiredTerminalTabSweepState = AgentStatusTabPrefixDropState &
  Pick<AppState, 'paneForegroundAgentByPaneKey'> &
  Partial<Pick<AppState, 'transferAgentPaneAuthority'>>

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
  opts?: { preserveActivityClearedState?: boolean; paneKeys?: ReadonlySet<string> }
): Partial<RetiredTerminalTabSweepState> | null {
  if (tabIds.length === 0) {
    return null
  }
  let swept: RetiredTerminalTabSweepState = state
  for (const tabId of tabIds) {
    if (!opts?.paneKeys) {
      afterPurgeAcceptance(state, () => retireParkedTerminalTab(tabId))
    }
    const { patch } = buildAgentStatusTabPrefixDropPatch(
      swept,
      tabId,
      opts?.paneKeys
        ? []
        : (findAgentStatusOwner(state)
            ?.authority()
            .retireAgentPaneAuthorityAliasesByOwnerTab(tabId) ?? []),
      {
        ...(worktreeId ? { worktreeId } : {}),
        ...(opts?.paneKeys ? { paneKeys: opts.paneKeys } : {}),
        ...(opts?.preserveActivityClearedState ? { preserveActivityClearedState: true } : {})
      }
    )
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
      preparePurgeOwnership(state, {
        install: prepareAgentHibernationOutputRemoval(new Set([tabId])),
        effects: []
      })
      afterPurgeAcceptance(state, () => forgetNativeChatPromptDismissalsForTab(tabId))
    }
  }
  if (!opts?.paneKeys) {
    afterPurgeAcceptance(state, () => forgetForegroundTerminalTabs(tabIds))
    preparePurgeOwnership(state, {
      install: prepareAgentStartupDeliveriesRemoval(new Set(tabIds)),
      effects: []
    })
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
