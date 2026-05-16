import type { TerminalTab } from '../../../../shared/types'

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
