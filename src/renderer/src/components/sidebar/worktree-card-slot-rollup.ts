import { useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { getWorktreeMapFromState } from '@/store/selectors'
import { isExplicitAgentStatusFresh } from '@/lib/pane-agent-evidence'
import { agentRowDisplayDotState } from '@/lib/agent-row-dot-state'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status/contracts/agent-status-freshness'
import { workspaceHasLiveMarker } from '@/store/slices/workspace-attention/workspace-live-markers'
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
  const worktreeMap = getWorktreeMapFromState(state)
  for (const worktreeId of descendantIds) {
    for (const entry of selectLiveAgentStatusEntriesForWorktree(state, worktreeId)) {
      if (!isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)) {
        continue
      }
      lines.push({
        kind: classifySlotLine({
          dotState: agentRowDisplayDotState({ state: entry.state, entry }),
          needsAttention: false,
          unreadCompletion: Boolean(state.unreadAgentCompletionPanes[entry.paneKey])
        }),
        at: entry.stateStartedAt > 0 ? entry.stateStartedAt : null
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
          unreadCompletion: Boolean(state.unreadAgentCompletionPanes[retained.entry.paneKey])
        }),
        at: retained.entry.stateStartedAt > 0 ? retained.entry.stateStartedAt : null
      })
    }
    const worktree = worktreeMap.get(worktreeId)
    if (worktree?.isUnread && !workspaceHasLiveMarker(state, worktreeId)) {
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
