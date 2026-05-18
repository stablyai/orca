import { detectAgentStatusFromTitle, isExplicitAgentStatusFresh } from '@/lib/agent-status'
import type { WorktreeStatus } from '@/lib/worktree-status'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/types'

type WorktreeCardStatusInput = {
  tabs: Pick<TerminalTab, 'id' | 'ptyId' | 'title'>[]
  browserTabs: { id: string }[]
  worktreeAgentEntries: AgentStatusEntry[]
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  now?: number
}

export function deriveWorktreeCardStatus({
  tabs,
  browserTabs,
  worktreeAgentEntries,
  runtimePaneTitlesByTabId,
  now = Date.now()
}: WorktreeCardStatusInput): WorktreeStatus {
  const liveTabs = tabs.filter((tab) => tab.ptyId)
  // Why: browser-only worktrees are still active from the user's point of
  // view even when they have no PTY-backed terminal. The sidebar filter
  // already treats them as active, so every navigation surface must reuse
  // that rule instead of showing a misleading inactive dot.
  const hasTerminals = liveTabs.length > 0 || browserTabs.length > 0
  if (!hasTerminals) {
    return 'inactive'
  }

  const freshByTabId = new Map<string, AgentStatusEntry[]>()
  const explicitPaneIdsByTabId = new Map<string, Set<string>>()
  for (const entry of worktreeAgentEntries) {
    if (!isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)) {
      continue
    }
    const colonIdx = entry.paneKey.indexOf(':')
    // Why: paneKey must be `${tabId}:${paneId}`. Skip malformed entries (no
    // colon or leading colon) rather than bucketing under "".
    if (colonIdx <= 0) {
      continue
    }
    const tabId = entry.paneKey.slice(0, colonIdx)
    const paneId = entry.paneKey.slice(colonIdx + 1)
    const bucket = freshByTabId.get(tabId)
    if (bucket) {
      bucket.push(entry)
    } else {
      freshByTabId.set(tabId, [entry])
    }
    const explicitPaneIds = explicitPaneIdsByTabId.get(tabId) ?? new Set<string>()
    explicitPaneIds.add(paneId)
    explicitPaneIdsByTabId.set(tabId, explicitPaneIds)
  }

  let hasPermission = false
  let hasWorking = false
  let hasDone = false
  for (const tab of liveTabs) {
    const fresh = freshByTabId.get(tab.id)
    if (fresh && fresh.length > 0) {
      if (fresh.some((e) => e.state === 'blocked' || e.state === 'waiting')) {
        hasPermission = true
      } else if (fresh.some((e) => e.state === 'working')) {
        hasWorking = true
      } else if (fresh.some((e) => e.state === 'done')) {
        hasDone = true
      }
    }

    const explicitPaneIds = explicitPaneIdsByTabId.get(tab.id)
    const paneTitles = runtimePaneTitlesByTabId[tab.id]
    if (paneTitles && Object.keys(paneTitles).length > 0) {
      for (const [paneId, title] of Object.entries(paneTitles)) {
        // Why: explicit hook status only supersedes the matching pane. Other
        // split panes still need the title heuristic when hooks are absent.
        if (explicitPaneIds?.has(paneId)) {
          continue
        }
        const heuristic = detectAgentStatusFromTitle(title)
        if (heuristic === 'permission') {
          hasPermission = true
          break
        }
        if (heuristic === 'working') {
          hasWorking = true
        }
      }
      continue
    }

    if (fresh && fresh.length > 0) {
      continue
    }

    const heuristic = detectAgentStatusFromTitle(tab.title)
    if (heuristic === 'permission') {
      hasPermission = true
    } else if (heuristic === 'working') {
      hasWorking = true
    }
  }

  if (hasPermission) {
    return 'permission'
  }
  if (hasWorking) {
    return 'working'
  }
  // Why: surface 'done' as its own status so the sidebar dot turns blue
  // (sky-500/80) — matching the dashboard's done color. A completed agent
  // still has a live terminal, so 'inactive' would be misleading; calling
  // it 'done' keeps the two surfaces in agreement on what the agent is.
  if (hasDone) {
    return 'done'
  }
  return 'active'
}
