import type { Tab } from '../../../shared/tab-types'
import { isStructuredTab } from '../../../shared/structured-agent-session-tab'

type DirectoryTab = {
  id: string
  entityId?: string
  contentType?: string
  agentSessionAgent?: unknown
}
type StructuredTabIndex = {
  byId: ReadonlyMap<string, DirectoryTab>
  bySessionId: ReadonlyMap<string, DirectoryTab>
  firstRegisteredById: ReadonlyMap<string, DirectoryTab>
}
const indexes = new WeakMap<readonly DirectoryTab[], StructuredTabIndex>()

function indexTabs(tabs: readonly DirectoryTab[] | undefined): StructuredTabIndex | undefined {
  if (!tabs) {
    return undefined
  }
  let index = indexes.get(tabs)
  if (!index) {
    const byId = new Map<string, DirectoryTab>()
    const bySessionId = new Map<string, DirectoryTab>()
    const firstRegisteredById = new Map<string, DirectoryTab>()
    tabs.forEach((tab) => {
      if (tab.contentType === 'agent-session') {
        const id = tab.id
        byId.set(id, tab)
        if (tab.entityId !== undefined) {
          bySessionId.set(tab.entityId, tab)
        }
        if (isStructuredTab(tab) && !firstRegisteredById.has(id)) {
          firstRegisteredById.set(id, tab)
        }
      }
    })
    index = { byId, bySessionId, firstRegisteredById }
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
  const tabs = workspaceTabs(tabsByWorkspace, workspaceId)
  return indexedTab(tabs, 'byId', id)
}

export function structuredChatTabBySessionId(
  tabsByWorkspace: TabsByWorkspace,
  workspaceId: string,
  sessionId: string
): Tab | undefined {
  const tabs = workspaceTabs(tabsByWorkspace, workspaceId)
  return indexedTab(tabs, 'bySessionId', sessionId)
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

/** Directory pins use the status bridge predicate and the first matching registered tab. */
export function firstRegisteredStructuredChatTab<T extends DirectoryTab>(
  tabs: readonly T[] | undefined,
  id: string
): T | undefined {
  return indexedTab(tabs, 'firstRegisteredById', id)
}

function indexedTab<T extends DirectoryTab>(
  tabs: readonly T[] | undefined,
  kind: keyof StructuredTabIndex,
  key: string
): T | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this weak index contains only rows of this exact immutable T array.
  return indexTabs(tabs)?.[kind].get(key) as T | undefined
}
