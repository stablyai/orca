// Pure reducers for the Database workspace tab bar: a permanent free-form
// "Query" tab plus one "Data" tab per opened table (DBeaver-style). The store
// slice owns async loading; this module only shapes the tab list + active id so
// the open/close/activate behavior is unit-testable without the store.

// The free-form SQL tab is permanent and shares a fixed id across connections.
export const DB_QUERY_TAB_ID = 'query'

export type DbWorkspaceTab =
  | { tabId: typeof DB_QUERY_TAB_ID; kind: 'query' }
  | { tabId: string; kind: 'table-data'; schema: string; table: string }

export type DbWorkspaceTabsState = { tabs: DbWorkspaceTab[]; activeTabId: string }

export function defaultWorkspaceTabs(): DbWorkspaceTabsState {
  return { tabs: [{ tabId: DB_QUERY_TAB_ID, kind: 'query' }], activeTabId: DB_QUERY_TAB_ID }
}

// Open (or re-focus) a table Data tab. Idempotent: re-opening an already-open
// table just activates its existing tab instead of adding a duplicate.
export function openTableTab(
  ws: DbWorkspaceTabsState,
  tabId: string,
  schema: string,
  table: string
): DbWorkspaceTabsState {
  const exists = ws.tabs.some((t) => t.tabId === tabId)
  const opened: DbWorkspaceTab = { tabId, kind: 'table-data', schema, table }
  const tabs = exists ? ws.tabs : [...ws.tabs, opened]
  return { tabs, activeTabId: tabId }
}

// Close a Data tab; the permanent Query tab is never removable. When the closed
// tab was active, focus its left neighbor (or the Query tab as a floor).
export function closeTab(ws: DbWorkspaceTabsState, tabId: string): DbWorkspaceTabsState {
  if (tabId === DB_QUERY_TAB_ID) {
    return ws
  }
  const index = ws.tabs.findIndex((t) => t.tabId === tabId)
  if (index === -1) {
    return ws
  }
  const tabs = ws.tabs.filter((t) => t.tabId !== tabId)
  let activeTabId = ws.activeTabId
  if (activeTabId === tabId) {
    activeTabId = (tabs[index - 1] ?? tabs[0])?.tabId ?? DB_QUERY_TAB_ID
  }
  return { tabs, activeTabId }
}

export function setActiveTab(ws: DbWorkspaceTabsState, tabId: string): DbWorkspaceTabsState {
  if (!ws.tabs.some((t) => t.tabId === tabId)) {
    return ws
  }
  return { ...ws, activeTabId: tabId }
}
