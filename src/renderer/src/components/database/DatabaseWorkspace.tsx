import React from 'react'
import { Table2, TerminalSquare, X } from 'lucide-react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { DB_QUERY_TAB_ID, defaultWorkspaceTabs } from '@/store/database-workspace-tabs'
import { QueryWorkspace } from './QueryWorkspace'
import { TableDataView } from './TableDataView'

// Tabbed workspace for one connection: a permanent free-form "Query" tab plus a
// "Data" tab per table opened from the schema tree. Only the active tab's content
// mounts — per-tab state lives in the store, so switching never loses work.
export function DatabaseWorkspace({ connectionId }: { connectionId: string }): React.JSX.Element {
  const ws = useAppStore((s) => s.dbWorkspaceTabs[connectionId])
  const setActiveDbTab = useAppStore((s) => s.setActiveDbTab)
  const closeDbTab = useAppStore((s) => s.closeDbTab)

  const tabs = ws?.tabs ?? defaultWorkspaceTabs().tabs
  const activeTabId = ws?.activeTabId ?? DB_QUERY_TAB_ID

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        role="tablist"
        className="scrollbar-sleek flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-muted/30 px-2"
      >
        {tabs.map((tab) => {
          const active = tab.tabId === activeTabId
          const isQuery = tab.kind === 'query'
          return (
            <div
              key={tab.tabId}
              role="tab"
              aria-selected={active}
              tabIndex={0}
              onClick={() => setActiveDbTab(connectionId, tab.tabId)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setActiveDbTab(connectionId, tab.tabId)
                }
              }}
              className={`group flex h-8 shrink-0 cursor-pointer items-center gap-1.5 border-b-2 px-2 text-xs outline-none ${
                active
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {isQuery ? (
                <TerminalSquare className="size-3.5 shrink-0" />
              ) : (
                <Table2 className="size-3.5 shrink-0" />
              )}
              <span className="max-w-[160px] truncate">
                {tab.kind === 'query'
                  ? translate('auto.components.database.DatabaseWorkspace.queryTab', 'Query')
                  : tab.table}
              </span>
              {tab.kind === 'table-data' ? (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    closeDbTab(connectionId, tab.tabId)
                  }}
                  aria-label={translate('auto.components.database.DatabaseWorkspace.closeTab', 'Close tab')}
                  className="opacity-0 hover:text-foreground group-hover:opacity-100"
                >
                  <X className="size-3" />
                </button>
              ) : null}
            </div>
          )
        })}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {activeTabId === DB_QUERY_TAB_ID ? (
          <QueryWorkspace connectionId={connectionId} />
        ) : (
          <TableDataView key={activeTabId} connectionId={connectionId} tabId={activeTabId} />
        )}
      </div>
    </div>
  )
}
