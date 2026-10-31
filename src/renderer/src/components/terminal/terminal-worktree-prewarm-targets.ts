import type { AppState } from '@/store/types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { getSleepingRecordTabId } from '@/lib/sleeping-agent-wake-requests'
import { resolveParkedTerminalPaneCandidates } from '../terminal-pane/terminal-parked-tab-watchers'

export function selectRevealTerminalTabIds(state: AppState, worktreeId: string): Set<string> {
  const revealTabIds = new Set<string>()
  const unifiedTabById = new Map(
    (state.unifiedTabsByWorktree[worktreeId] ?? []).map((tab) => [tab.id, tab])
  )
  for (const group of state.groupsByWorktree[worktreeId] ?? []) {
    const tab = group.activeTabId ? unifiedTabById.get(group.activeTabId) : undefined
    if (tab?.contentType === 'terminal') {
      revealTabIds.add(tab.entityId)
    }
  }
  const rememberedTabId = state.activeTabIdByWorktree[worktreeId]
  if (revealTabIds.size === 0 && rememberedTabId) {
    revealTabIds.add(rememberedTabId)
  }
  return revealTabIds
}

export function selectSleepingTabIds(state: AppState, worktreeId: string): Set<string> {
  const tabIds = new Set<string>()
  for (const record of Object.values(state.sleepingAgentSessionsByPaneKey)) {
    const tabId = record.worktreeId === worktreeId ? getSleepingRecordTabId(record) : null
    if (tabId) {
      tabIds.add(tabId)
    }
  }
  return tabIds
}

// Each stage waits for an idle slot after the previous commit; the timeout keeps it ready before a typical press.
export function scheduleTerminalPrewarmStage(callback: () => void): () => void {
  if (typeof requestIdleCallback !== 'function') {
    const timer = setTimeout(callback, 16)
    return () => clearTimeout(timer)
  }
  const handle = requestIdleCallback(callback, { timeout: 60 })
  return () => cancelIdleCallback(handle)
}

export function resolveReattachPtyIds(tab: TerminalTab, state: AppState): string[] {
  return resolveParkedTerminalPaneCandidates(tab, state).flatMap((pane) =>
    pane.ptyId ? [pane.ptyId] : []
  )
}
