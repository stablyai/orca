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

type TabsByWorkspace = Readonly<Record<string, readonly Tab[] | undefined>> | undefined

/** Own entries only: a paired host's workspace id can name an `Object.prototype` member. */
function workspaceTabs(
  tabsByWorkspace: TabsByWorkspace,
  workspaceId: string
): readonly Tab[] | undefined {
  return tabsByWorkspace && Object.hasOwn(tabsByWorkspace, workspaceId)
    ? tabsByWorkspace[workspaceId]
    : undefined
}

export function structuredChatTabById(
  tabsByWorkspace: TabsByWorkspace,
  workspaceId: string,
  id: string
): Tab | undefined {
  return indexTabs(workspaceTabs(tabsByWorkspace, workspaceId))?.byId.get(id)
}

export function structuredChatTabBySessionId(
  tabsByWorkspace: TabsByWorkspace,
  workspaceId: string,
  sessionId: string
): Tab | undefined {
  return indexTabs(workspaceTabs(tabsByWorkspace, workspaceId))?.bySessionId.get(sessionId)
}
