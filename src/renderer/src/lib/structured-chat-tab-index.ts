import type { Tab } from '../../../shared/tab-types'

const sourceKeys = new WeakMap<object, readonly string[]>()
export function ownSourceKeys<T>(source: WorkspaceTabMap<T>): readonly string[] {
  let keys = sourceKeys.get(source)
  if (!keys) {
    keys = Object.keys(source)
    sourceKeys.set(source, keys)
  }
  return keys
}

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
type WorkspaceTabMap<T = readonly WorkspaceTab[] | undefined> = Readonly<Record<string, T>>
const workspaceIndexes = new WeakMap<
  WorkspaceTabMap,
  {
    byTabId: Map<string, string>
    bySessionId: Map<string, string[]>
    structuredTabs: { workspaceId: string; tabIndex: number }[]
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
    const structuredTabs: { workspaceId: string; tabIndex: number }[] = []
    for (const workspaceId of ownSourceKeys(tabsByWorkspace)) {
      const tabs = tabsByWorkspace[workspaceId]
      for (const [tabIndex, { id, contentType, entityId }] of (tabs ?? []).entries()) {
        if (contentType === 'agent-session') {
          structuredTabs.push({ workspaceId, tabIndex })
        }
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
    index = { byTabId, bySessionId, structuredTabs }
    workspaceIndexes.set(tabsByWorkspace, index)
  }
  return index
}

export function structuredChatTabs(tabsByWorkspace: NonNullable<TabsByWorkspace>): Tab[] {
  return (indexWorkspaces(tabsByWorkspace)?.structuredTabs ?? []).flatMap(
    ({ workspaceId, tabIndex }) => tabsByWorkspace[workspaceId]?.[tabIndex] ?? []
  )
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
