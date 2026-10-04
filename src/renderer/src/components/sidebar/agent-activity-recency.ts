import { agentEntryCompletionAt } from '../../../../shared/agent-completion-time'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { buildExplicitEntriesByTabId, buildExplicitEntriesByWorktreeId } from './smart-attention'

/** Latest turn start or completion an entry reports, else 0; a stopped turn counts by its start. */
export function agentEntryActivityAt(entry: AgentStatusEntry): number {
  const current = entry.state === 'done' ? agentEntryCompletionAt(entry) : entry.stateStartedAt
  let latest = current !== null && Number.isFinite(current) ? current : 0
  for (const row of entry.stateHistory) {
    if (row.state === 'working' && Number.isFinite(row.startedAt) && row.startedAt > latest) {
      latest = row.startedAt
    }
  }
  return latest
}

/**
 * Latest agent activity per worktree id, with `buildAttentionByWorktree`'s pane ownership.
 * Why stale entries count: attention ages out after 30 minutes; the activity time does not.
 */
export function buildAgentActivityByWorktree(
  worktrees: readonly Worktree[],
  tabsByWorktree: Record<string, TerminalTab[]> | null,
  agentStatusByPaneKey: Record<string, AgentStatusEntry> | undefined
): Map<string, number> {
  const byTab = buildExplicitEntriesByTabId(agentStatusByPaneKey)
  const byAttributedWorktree = buildExplicitEntriesByWorktreeId(agentStatusByPaneKey)
  const mirroredTabIds = new Set<string>()
  for (const tabs of Object.values(tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      mirroredTabIds.add(tab.id)
    }
  }
  const result = new Map<string, number>()
  for (const worktree of worktrees) {
    let latest = 0
    for (const entry of byAttributedWorktree.get(worktree.id) ?? []) {
      const tabId = parsePaneKey(entry.paneKey)?.tabId
      if (tabId !== undefined && !mirroredTabIds.has(tabId)) {
        latest = Math.max(latest, agentEntryActivityAt(entry))
      }
    }
    for (const tab of tabsByWorktree?.[worktree.id] ?? []) {
      for (const entry of byTab.get(tab.id) ?? []) {
        latest = Math.max(latest, agentEntryActivityAt(entry))
      }
    }
    if (latest > 0) {
      result.set(worktree.id, latest)
    }
  }
  return result
}
