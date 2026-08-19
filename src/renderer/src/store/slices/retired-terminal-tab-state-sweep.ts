import type { AppState } from '../types'
import { forgetAgentHibernationTabOutput } from '@/lib/agent-hibernation-output-activity'
import { forgetForegroundTerminalTabs } from '@/lib/foreground-terminal-tabs'
import { forgetAgentStartupDeliveriesForTabs } from '@/lib/agent-startup-delivery-guards'
// Why: the store-free registry (not terminal-parked-tab-watchers, which imports @/store) so a slice can import this module during its own evaluation.
import { retireParkedTerminalTab } from '@/components/terminal-pane/terminal-parked-watcher-registry'
import { retireAgentPaneAuthorityAliasesByOwnerTab } from './agent-pane-authority'
import {
  buildAgentStatusTabPrefixDropPatch,
  type AgentStatusTabPrefixDropState
} from './agent-status'
import { buildPaneForegroundAgentTabPrefixClearPatch } from './pane-foreground-agent'

export type RetiredTerminalTabSweepActions = Pick<
  AppState,
  'dropAgentStatusByTabPrefix' | 'clearPaneForegroundAgentByTabPrefix'
>

/** The state the sweep reduces over: the two store maps plus everything the
 *  agent-status drop reads. Narrow so a non-store caller can pass its own view. */
export type RetiredTerminalTabSweepState = AgentStatusTabPrefixDropState &
  Pick<AppState, 'paneForegroundAgentByPaneKey'>

/**
 * Every renderer-side map a retired terminal tab leaves behind that no `set()` on the session model
 * reaches: two suppressor-aware store actions plus three module-level registries.
 *
 * One unit with two callers on purpose. `closeTab` grew this list inline, so the peer-retirement path
 * (remote-workspace-host-tab-retirement) removed a tab through the pure session transform and swept
 * none of it — a background pane's `agentStatusByPaneKey` row outlived its tab and kept rendering a
 * live sidebar agent row that nothing could clear. A second copy of the list is how that recurs.
 *
 * Must run AFTER the tab is out of `tabsByWorktree`: dropAgentStatusByTabPrefix's completed-orphan
 * sweep is defined as "keyed under a tab id this worktree no longer has".
 */
export function sweepRetiredTerminalTabState(
  actions: RetiredTerminalTabSweepActions,
  tabId: string,
  worktreeId?: string | null
): void {
  // Why: idempotent, and retirement has no earlier hook — closeTab still revokes these before its own
  // provider teardown, where the ordering against pty exit is load-bearing.
  retireParkedTerminalTab(tabId)
  // Why: sweep tab agent status through its suppressor-aware removal path.
  // Why the worktree: Pi can leave a completed row keyed under an already-missing tab id; passing it sweeps that orphan while preserving active pre-render child rows.
  actions.dropAgentStatusByTabPrefix(tabId, worktreeId ? { worktreeId } : undefined)
  // Why: retired pane keys never recur, so stranded foreground entries would accumulate for the renderer's whole lifetime.
  actions.clearPaneForegroundAgentByTabPrefix(tabId)
  // Why: retirement permanently retires the tab's panes (a reopen mints a fresh leafId), so drop hibernation output epochs to keep the module map from growing forever.
  forgetAgentHibernationTabOutput(tabId)
  // Why: same rationale — retired tab ids never recur, so drop the foreground last-seen and consumed agent-startup delivery guards.
  forgetForegroundTerminalTabs([tabId])
  forgetAgentStartupDeliveriesForTabs([tabId])
}

/**
 * The same sweep for a caller that owns its own `set()`. The paired snapshot apply assembles one
 * patch per snapshot from a state the store has not seen yet, so it cannot reach the store actions —
 * it folds this patch in instead. Registry side effects still fire, exactly as in the action form.
 *
 * `state` must already exclude the retired tabs from `tabsByWorktree`, for the same reason.
 */
export function buildRetiredTerminalTabStateSweepPatch(
  state: RetiredTerminalTabSweepState,
  tabIds: readonly string[],
  worktreeId?: string | null
): Partial<RetiredTerminalTabSweepState> | null {
  if (tabIds.length === 0) {
    return null
  }
  let swept: RetiredTerminalTabSweepState = state
  for (const tabId of tabIds) {
    retireParkedTerminalTab(tabId)
    const { patch } = buildAgentStatusTabPrefixDropPatch(
      swept,
      tabId,
      retireAgentPaneAuthorityAliasesByOwnerTab(tabId),
      worktreeId ? { worktreeId } : undefined
    )
    const foreground = buildPaneForegroundAgentTabPrefixClearPatch(
      swept.paneForegroundAgentByPaneKey,
      [`${tabId}:`]
    )
    swept = { ...swept, ...patch, ...foreground }
    forgetAgentHibernationTabOutput(tabId)
  }
  forgetForegroundTerminalTabs(tabIds)
  forgetAgentStartupDeliveriesForTabs(tabIds)
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
