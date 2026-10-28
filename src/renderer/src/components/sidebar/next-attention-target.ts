import { useAppStore } from '@/store'
import { getAllWorktreesFromState } from '@/store/selectors'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { isExplicitAgentStatusFresh } from '@/lib/pane-agent-evidence'
import { activateStructuredAgentSessionTab } from '@/lib/structured-agent-session-tab-activation'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import type { AppState } from '@/store/types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import {
  getFocusedAgentPaneKeyForWorktree,
  type FocusedAgentRowHighlightState
} from './focused-agent-row-highlight'
import { buildAttentionByWorktree, type WorktreeAttention } from './smart-attention'

export type AttentionPane = { paneKey: string; tabId: string; leafId: string }

export type AttentionTarget = {
  worktreeId: string
  // Why nullable: title-heuristic promotions carry no pane key, so only the worktree can be activated.
  pane: AttentionPane | null
  executionHostId?: ExecutionHostId
}

/**
 * Next worktree whose agent needs input, most recent first. Starts after the active worktree
 * so repeated presses walk every waiting agent instead of bouncing between the newest two.
 */
export function pickNextAttentionWorktree(
  attentionByWorktree: ReadonlyMap<string, WorktreeAttention>,
  activeWorktreeId: string | null
): string | null {
  const waitingIds = [...attentionByWorktree.entries()]
    .filter(([, attention]) => attention.cls === 1)
    .sort(([, a], [, b]) => b.attentionTimestamp - a.attentionTimestamp)
    .map(([worktreeId]) => worktreeId)
  if (waitingIds.length === 0) {
    return null
  }
  const activeIndex = activeWorktreeId === null ? -1 : waitingIds.indexOf(activeWorktreeId)
  return waitingIds[(activeIndex + 1) % waitingIds.length]
}

/** `blocked`/`waiting` panes on the worktree's own tabs, freshest first. */
export function listAttentionPanes(
  ownedTabIds: ReadonlySet<string>,
  agentStatusByPaneKey: Readonly<Record<string, AgentStatusEntry>>,
  now: number
): AttentionPane[] {
  const panes: (AttentionPane & { startedAt: number })[] = []
  for (const entry of Object.values(agentStatusByPaneKey)) {
    if (entry.state !== 'blocked' && entry.state !== 'waiting') {
      continue
    }
    // Why: same gates as smart-attention, so the pane we focus is the one that ranked the worktree.
    if (
      !isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS) ||
      !Number.isFinite(entry.stateStartedAt)
    ) {
      continue
    }
    const parsed = parsePaneKey(entry.paneKey)
    // Why tab ownership over the worktree stamp: a stamped row can name another worktree's tab,
    // and focusing it would reveal that worktree's pane inside this one.
    if (parsed === null || !ownedTabIds.has(parsed.tabId)) {
      continue
    }
    panes.push({
      paneKey: entry.paneKey,
      tabId: parsed.tabId,
      leafId: parsed.leafId,
      startedAt: entry.stateStartedAt
    })
  }
  return panes
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(({ paneKey, tabId, leafId }) => ({ paneKey, tabId, leafId }))
}

/** Next waiting agent: the remaining ones in the active worktree first, then the next worktree. */
export function pickNextAttentionTarget(args: {
  attentionByWorktree: ReadonlyMap<string, WorktreeAttention>
  activeWorktreeId: string | null
  focusedPaneKey: string | null
  ownedTabIds: (worktreeId: string) => ReadonlySet<string>
  agentStatusByPaneKey: Readonly<Record<string, AgentStatusEntry>>
  now: number
}): AttentionTarget | null {
  const panesOf = (worktreeId: string) =>
    listAttentionPanes(args.ownedTabIds(worktreeId), args.agentStatusByPaneKey, args.now)
  const { activeWorktreeId } = args
  if (activeWorktreeId !== null && args.attentionByWorktree.get(activeWorktreeId)?.cls === 1) {
    const activePanes = panesOf(activeWorktreeId)
    const focusedIndex = activePanes.findIndex((pane) => pane.paneKey === args.focusedPaneKey)
    const nextPane = activePanes[focusedIndex + 1]
    if (nextPane) {
      return { worktreeId: activeWorktreeId, pane: nextPane }
    }
  }
  const worktreeId = pickNextAttentionWorktree(args.attentionByWorktree, activeWorktreeId)
  return worktreeId === null ? null : { worktreeId, pane: panesOf(worktreeId)[0] ?? null }
}

/** Focused agent pane in the active worktree, whether it is a terminal pane or a structured chat tab. */
export function resolveFocusedAttentionPaneKey(
  state: FocusedAgentRowHighlightState & Pick<AppState, 'getActiveTab'>
): string | null {
  const { activeWorktreeId } = state
  if (!activeWorktreeId) {
    return null
  }
  if (state.activeTabType === 'agent-session') {
    // Why: the sidebar highlight helper is terminal-only; structured tabs key their status by this projection.
    const tab = state.getActiveTab(activeWorktreeId)
    return tab?.contentType === 'agent-session'
      ? structuredAgentSessionPaneKey(tab.id, tab.entityId)
      : null
  }
  return getFocusedAgentPaneKeyForWorktree(state, activeWorktreeId)
}

/** Side-effect free, so the shortcut can decline the chord before claiming it. */
export function resolveNextAttentionTarget(): AttentionTarget | null {
  const state = useAppStore.getState()
  const now = Date.now()
  const worktrees = getAllWorktreesFromState(state).filter((worktree) => !worktree.isArchived)
  const target = pickNextAttentionTarget({
    attentionByWorktree: buildAttentionByWorktree(
      worktrees,
      state.tabsByWorktree,
      state.agentStatusByPaneKey,
      state.runtimePaneTitlesByTabId,
      state.ptyIdsByTabId,
      now,
      state.migrationUnsupportedByPtyId,
      state.terminalLayoutsByTabId
    ),
    activeWorktreeId: state.activeWorktreeId,
    focusedPaneKey: resolveFocusedAttentionPaneKey(state),
    ownedTabIds: (worktreeId) =>
      new Set([
        ...(state.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id),
        ...(state.unifiedTabsByWorktree[worktreeId] ?? [])
          .filter((tab) => tab.contentType === 'agent-session')
          .map((tab) => tab.id)
      ]),
    agentStatusByPaneKey: state.agentStatusByPaneKey,
    now
  })
  if (target === null) {
    return null
  }
  // Why: host-qualified worktrees need their host so activation resolves the same row the sidebar shows.
  const hostId = worktrees.find((worktree) => worktree.id === target.worktreeId)?.hostId
  return hostId ? { ...target, executionHostId: hostId } : target
}

/** Mirrors the sidebar agent-row click: activate the worktree, then focus and acknowledge the pane. */
export function focusAttentionTarget(target: AttentionTarget): void {
  activateAndRevealWorktree(
    target.worktreeId,
    target.executionHostId ? { executionHostId: target.executionHostId } : {}
  )
  const { pane } = target
  if (pane === null) {
    return
  }
  const terminalTabs = useAppStore.getState().tabsByWorktree[target.worktreeId] ?? []
  if (terminalTabs.some((tab) => tab.id === pane.tabId)) {
    activateTabAndFocusPane(pane.tabId, pane.leafId, {
      ackPaneKeyOnSuccess: pane.paneKey,
      flashFocusedPane: true,
      scrollToBottomIfOutputSinceLastView: true
    })
    return
  }
  activateStructuredAgentSessionTab({ worktreeId: target.worktreeId, tabId: pane.tabId })
}
