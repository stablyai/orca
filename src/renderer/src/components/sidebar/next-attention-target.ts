import { isExplicitAgentStatusFresh } from '@/lib/pane-agent-evidence'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { activateTerminalInitiatedWorktree } from '@/lib/terminal-initiated-worktree-activation'
import { useAppStore } from '@/store'
import { getAllWorktreesFromState } from '@/store/selectors'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/types'
import { buildAttentionByWorktree, type WorktreeAttention } from './smart-attention'

export type AttentionTarget = {
  worktreeId: string
  /** Null for worktrees promoted by the title heuristic, which carry no paneKey to focus. */
  tabId: string | null
  leafId: string | null
}

/**
 * Pick the pane to focus inside an attention worktree: the freshest `blocked`/`waiting`
 * hook entry it owns. Mirrors the paneKey the notification click handler focuses.
 */
function resolveAttentionPane(
  worktreeId: string,
  agentStatusByPaneKey: Record<string, AgentStatusEntry>,
  tabsByWorktree: Record<string, TerminalTab[]>,
  now: number
): Pick<AttentionTarget, 'tabId' | 'leafId'> {
  const worktreeTabIds = new Set((tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id))
  let best: { tabId: string; leafId: string; startedAt: number } | null = null

  for (const entry of Object.values(agentStatusByPaneKey)) {
    if (entry.state !== 'blocked' && entry.state !== 'waiting') {
      continue
    }
    if (!isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)) {
      continue
    }
    // Why: a non-finite stateStartedAt would win every comparison and pin focus to a corrupted row.
    if (!Number.isFinite(entry.stateStartedAt)) {
      continue
    }
    const parsed = parsePaneKey(entry.paneKey)
    if (parsed === null) {
      continue
    }
    // Why tab ownership alone: a row stamped for this worktree can still name another worktree's
    // tab, and focusing that would activate one worktree while revealing another's pane. The stamp
    // already decided which worktree is Class 1; here it must not override live tab ownership.
    if (!worktreeTabIds.has(parsed.tabId)) {
      continue
    }
    if (best === null || entry.stateStartedAt > best.startedAt) {
      best = { tabId: parsed.tabId, leafId: parsed.leafId, startedAt: entry.stateStartedAt }
    }
  }

  return best ? { tabId: best.tabId, leafId: best.leafId } : { tabId: null, leafId: null }
}

/**
 * Resolve the agent that should receive focus next: Class 1 (`blocked`/`waiting`) worktrees
 * ordered by most recent attention event, skipping the one already on screen so repeated
 * presses walk the queue. Returns null when nothing is waiting.
 */
export function findNextAttentionTarget(args: {
  attentionByWorktree: Map<string, WorktreeAttention>
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  tabsByWorktree: Record<string, TerminalTab[]>
  eligibleWorktreeIds: Set<string>
  activeWorktreeId: string | null
  now: number
}): AttentionTarget | null {
  const waiting = [...args.attentionByWorktree.entries()]
    .filter(([id, attention]) => attention.cls === 1 && args.eligibleWorktreeIds.has(id))
    .sort(([, a], [, b]) => b.attentionTimestamp - a.attentionTimestamp)

  if (waiting.length === 0) {
    return null
  }

  const [worktreeId] = waiting.find(([id]) => id !== args.activeWorktreeId) ?? waiting[0]
  return {
    worktreeId,
    ...resolveAttentionPane(worktreeId, args.agentStatusByPaneKey, args.tabsByWorktree, args.now)
  }
}

/**
 * Read the live store and resolve the next agent waiting on input. Side-effect free so a
 * shortcut handler can decline the chord (returning null) before claiming the key event.
 */
export function resolveNextAttentionTarget(): AttentionTarget | null {
  const state = useAppStore.getState()
  const worktrees = getAllWorktreesFromState(state).filter((worktree) => !worktree.isArchived)
  const now = Date.now()

  return findNextAttentionTarget({
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
    agentStatusByPaneKey: state.agentStatusByPaneKey,
    tabsByWorktree: state.tabsByWorktree,
    eligibleWorktreeIds: new Set(worktrees.map((worktree) => worktree.id)),
    activeWorktreeId: state.activeWorktreeId,
    now
  })
}

/**
 * Focus a resolved attention target through the same path the notification click uses:
 * activate the worktree, reveal it in the sidebar, then flash and scroll its exact pane.
 */
export function focusAttentionTarget(target: AttentionTarget): void {
  const state = useAppStore.getState()
  activateTerminalInitiatedWorktree(state, target.worktreeId)
  state.revealWorktreeInSidebar(target.worktreeId)
  if (target.tabId !== null) {
    activateTabAndFocusPane(target.tabId, target.leafId, {
      flashFocusedPane: true,
      scrollToBottomIfOutputSinceLastView: true
    })
  }
}
