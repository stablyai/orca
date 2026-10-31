import { create } from 'zustand'
import type { AgentSessionStatusSummary } from '../../../../shared/agent-session-wire'

/** Read-only projection of the existing host feed, keyed by its visible tab identity. */
export const useStructuredSessionSummaries = create<{
  byTabId: ReadonlyMap<string, AgentSessionStatusSummary>
  threadTabIds: ReadonlySet<string>
}>(() => ({ byTabId: new Map(), threadTabIds: new Set() }))

export function publishStructuredSessionSummaries(
  updates: readonly { tabId: string; summary: AgentSessionStatusSummary | null }[]
): void {
  const { byTabId: previous, threadTabIds } = useStructuredSessionSummaries.getState()
  let classified: Set<string> | undefined
  let next: Map<string, AgentSessionStatusSummary> | undefined
  for (const { tabId, summary } of updates) {
    if ((previous.get(tabId) ?? null) === summary) {
      continue
    }
    next ??= new Map(previous)
    if (summary) {
      next.set(tabId, summary)
    } else {
      next.delete(tabId)
    }
    if (threadTabIds.has(tabId) !== (summary?.surface === 'thread')) {
      classified ??= new Set(threadTabIds)
      if (summary?.surface === 'thread') {
        classified.add(tabId)
      } else {
        classified.delete(tabId)
      }
    }
  }
  if (next) {
    useStructuredSessionSummaries.setState({
      byTabId: next,
      ...(classified ? { threadTabIds: classified } : {})
    })
  }
}

export function isThreadTab(
  enabled: boolean,
  tabId: string,
  threadTabIds: ReadonlySet<string>
): boolean {
  return enabled && threadTabIds.has(tabId)
}
