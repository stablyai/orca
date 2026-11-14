import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import { parsePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import { mainAgentDoneAt } from '../../../../../../shared/agent-status/lifecycle/main-agent-status'

export type PromptCacheCountdownSelection = {
  startedAt: number
  ttlMs: number
}

export function getStructuredPromptCacheStartedAt(
  entry: AgentStatusEntry | undefined
): number | null {
  if (entry?.agentType !== 'claude') {
    return null
  }
  // Rejected launches can publish done rows before any conversation exists.
  if (entry.mainAgent?.outcome === 'failure' && !entry.prompt && !entry.lastAssistantMessage) {
    return null
  }
  return mainAgentDoneAt(entry) ?? null
}

function getCacheTimerTabId(key: string): string | null {
  const separator = key.indexOf(':')
  return separator > 0 ? key.slice(0, separator) : null
}

export function getMostUrgentPromptCacheStartedAt(
  tabs: readonly Pick<TerminalTab, 'id'>[] | undefined,
  cacheTimerByKey: Record<string, number | null>
): number | null {
  if (!tabs || tabs.length === 0) {
    return null
  }
  const tabIds = new Set(tabs.map((tab) => tab.id))
  let oldest: number | null = null
  for (const [key, startedAt] of Object.entries(cacheTimerByKey)) {
    if (startedAt == null) {
      continue
    }
    const tabId = getCacheTimerTabId(key)
    if (!tabId || !tabIds.has(tabId)) {
      continue
    }
    if (oldest === null || startedAt < oldest) {
      oldest = startedAt
    }
  }
  return oldest
}

export function getPromptCacheCountdownForPane(
  paneKey: string,
  cacheTimerByKey: Record<string, number | null>,
  ttlMs: number
): PromptCacheCountdownSelection | null {
  if (ttlMs <= 0 || parsePaneKey(paneKey) === null) {
    return null
  }
  const startedAt = cacheTimerByKey[paneKey]
  return startedAt == null ? null : { startedAt, ttlMs }
}
