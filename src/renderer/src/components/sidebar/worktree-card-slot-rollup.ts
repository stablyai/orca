import { useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { getWorktreeMapFromState } from '@/store/selectors'
import { isExplicitAgentStatusFresh } from '@/lib/pane-agent-evidence'
import { agentRowDisplayDotState } from '@/lib/agent-row-dot-state'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status/contracts/agent-status-freshness'
import { isAgentSubjectUnread } from '@/attention/agent-attention-acknowledgement'
import { readAgentRowTurnRecords } from '@/components/dashboard/dashboard-row-bucket'
import {
  selectLiveAgentStatusEntriesForWorktree,
  selectRetainedAgentEntriesForWorktree
} from './workspace-card/activity/worktree-agent-row-selectors'
import {
  classifySlotLine,
  slotExceptionFor,
  type SlotLineSignal,
  type SlotSignal
} from './worktree-card-slot-signal'

/** Exceptions inside collapsed child workspaces, read from the same live and retained agent records the rows use. */
export function selectCollapsedLineageSlot(
  state: AppState,
  descendantIds: readonly string[]
): SlotSignal | null {
  if (descendantIds.length === 0) {
    return null
  }
  const now = Date.now()
  const lines: SlotLineSignal[] = []
  // Same acknowledgement records the agent rows read, so a child's unread matches its own card.
  const turnRecords = readAgentRowTurnRecords(state)
  const worktreeMap = getWorktreeMapFromState(state)
  for (const worktreeId of descendantIds) {
    for (const entry of selectLiveAgentStatusEntriesForWorktree(state, worktreeId)) {
      if (!isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)) {
        continue
      }
      const dotState = agentRowDisplayDotState({ state: entry.state, entry })
      lines.push({
        kind: classifySlotLine({
          dotState,
          needsAttention: false,
          unreadCompletion: isAgentSubjectUnread(turnRecords, entry.paneKey)
        }),
        at: entry.stateStartedAt > 0 ? entry.stateStartedAt : null,
        monitoring: dotState === 'monitoring'
      })
    }
    for (const retained of selectRetainedAgentEntriesForWorktree(state, worktreeId)) {
      lines.push({
        kind: classifySlotLine({
          dotState: agentRowDisplayDotState({
            state: 'done',
            entry: retained.entry
          }),
          needsAttention: false,
          unreadCompletion: isAgentSubjectUnread(turnRecords, retained.entry.paneKey)
        }),
        at: retained.entry.stateStartedAt > 0 ? retained.entry.stateStartedAt : null
      })
    }
    const worktree = worktreeMap.get(worktreeId)
    // Any unread source counts: a tab or pane marker, or the user's own mark.
    if (worktree?.isUnread) {
      lines.push({ kind: 'unread', at: worktree.lastActivityAt || null })
    }
  }
  return slotExceptionFor(lines)
}

export function useCollapsedLineageSlot(descendantIds: readonly string[]): SlotSignal | null {
  const descendantKey = descendantIds.join('\n')
  const selector = useCallback(
    (state: AppState) =>
      selectCollapsedLineageSlot(state, descendantKey ? descendantKey.split('\n') : []),
    [descendantKey]
  )
  return useAppStore(useShallow(selector))
}

/** The most recent activity among child workspaces, so a parent never looks older than its children. */
export function selectLineageLatestAt(
  state: AppState,
  descendantIds: readonly string[]
): number | null {
  let at = 0
  const worktreeMap = getWorktreeMapFromState(state)
  for (const worktreeId of descendantIds) {
    at = Math.max(at, worktreeMap.get(worktreeId)?.lastActivityAt ?? 0)
    for (const entry of selectLiveAgentStatusEntriesForWorktree(state, worktreeId)) {
      at = Math.max(at, entry.stateStartedAt)
    }
    for (const retained of selectRetainedAgentEntriesForWorktree(state, worktreeId)) {
      at = Math.max(at, retained.entry.stateStartedAt)
    }
  }
  return at > 0 ? at : null
}

export function useLineageLatestAt(descendantIds: readonly string[]): number | null {
  const descendantKey = descendantIds.join('\n')
  return useAppStore(
    useCallback(
      (state: AppState) =>
        selectLineageLatestAt(state, descendantKey ? descendantKey.split('\n') : []),
      [descendantKey]
    )
  )
}

export type LineageChildCounts = { needs: number; failed: number; unread: number; working: number }

/** Direct children counted once each by their most urgent exception; quiet children aren't counted. */
export function selectLineageChildCounts(
  state: AppState,
  childIds: readonly string[]
): LineageChildCounts {
  const counts: LineageChildCounts = { needs: 0, failed: 0, unread: 0, working: 0 }
  for (const childId of childIds) {
    const signal = selectCollapsedLineageSlot(state, [childId])
    if (signal && signal.kind in counts) {
      counts[signal.kind as keyof LineageChildCounts] += 1
    }
  }
  return counts
}

export function useLineageChildCounts(childIds: readonly string[]): LineageChildCounts {
  const childKey = childIds.join('\n')
  const selector = useCallback(
    (state: AppState) => selectLineageChildCounts(state, childKey ? childKey.split('\n') : []),
    [childKey]
  )
  return useAppStore(useShallow(selector))
}
