import type { Tab } from '../../../shared/tab-types'

type StructuredTabIndex = {
  byId: ReadonlyMap<string, Tab>
  bySessionId: ReadonlyMap<string, Tab>
}
const indexes = new WeakMap<readonly Tab[], StructuredTabIndex>()

function indexTabs(tabs: readonly Tab[] | undefined): StructuredTabIndex | undefined {
  if (!tabs) {
    return undefined
  }
  let index = indexes.get(tabs)
  if (!index) {
    const byId = new Map<string, Tab>()
    const bySessionId = new Map<string, Tab>()
    for (const tab of tabs) {
      if (tab.contentType === 'agent-session') {
        byId.set(tab.id, tab)
        bySessionId.set(tab.entityId, tab)
      }
    }
    index = { byId, bySessionId }
    indexes.set(tabs, index)
  }
  return index
}

export function structuredChatTabById(
  tabs: readonly Tab[] | undefined,
  id: string
): Tab | undefined {
  return indexTabs(tabs)?.byId.get(id)
}

export function structuredChatTabBySessionId(
  tabs: readonly Tab[] | undefined,
  sessionId: string
): Tab | undefined {
  return indexTabs(tabs)?.bySessionId.get(sessionId)
}
