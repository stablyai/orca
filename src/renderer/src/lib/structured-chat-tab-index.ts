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

type WorkspaceTab = Pick<Tab, 'id'> & Partial<Pick<Tab, 'contentType' | 'entityId'>>
type WorkspaceTabMap = Readonly<Record<string, readonly WorkspaceTab[] | undefined>>
const workspaceIndexes = new WeakMap<
  WorkspaceTabMap,
  {
    byTabId: Map<string, string>
    bySessionId: Map<string, string[]>
  }
>()

function indexWorkspaces(tabsByWorkspace: WorkspaceTabMap | undefined) {
  if (!tabsByWorkspace) {
    return undefined
  }
  let index = workspaceIndexes.get(tabsByWorkspace)
  if (!index) {
    const byTabId = new Map<string, string>()
    const bySessionId = new Map<string, string[]>()
    for (const [workspaceId, tabs] of Object.entries(tabsByWorkspace)) {
      for (const { id, contentType, entityId } of tabs ?? []) {
        if (contentType && contentType !== 'agent-session') {
          continue
        }
        if (!byTabId.has(id)) {
          byTabId.set(id, workspaceId)
        }
        if (entityId === undefined) {
          continue
        }
        const candidates = bySessionId.get(entityId) ?? []
        if (candidates.at(-1) !== workspaceId) {
          candidates.push(workspaceId)
        }
        bySessionId.set(entityId, candidates)
      }
    }
    index = { byTabId, bySessionId }
    workspaceIndexes.set(tabsByWorkspace, index)
  }
  return index
}

export function structuredChatWorkspacesBySessionId(
  tabsByWorkspace: TabsByWorkspace,
  sessionId: string
): readonly string[] {
  return indexWorkspaces(tabsByWorkspace)?.bySessionId.get(sessionId) ?? []
}

export function chatWorkspaceByTabId(tabsByWorkspace: WorkspaceTabMap | undefined, tabId: string) {
  return indexWorkspaces(tabsByWorkspace)?.byTabId.get(tabId) ?? null
}
