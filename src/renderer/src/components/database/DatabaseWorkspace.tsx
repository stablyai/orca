import React, { useState } from 'react'
import { Table2, TerminalSquare, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { DB_QUERY_TAB_ID, defaultWorkspaceTabs } from '@/store/database-workspace-tabs'
import { isBufferDirty } from './table-data-edit-buffer'
import { QueryWorkspace } from './QueryWorkspace'
import { TableDataView } from './TableDataView'

// Tabbed workspace for one connection: a permanent free-form "Query" tab plus a
// "Data" tab per table opened from the schema tree. Only the active tab's content
// mounts — per-tab state lives in the store, so switching never loses work.
export function DatabaseWorkspace({ connectionId }: { connectionId: string }): React.JSX.Element {
  const ws = useAppStore((s) => s.dbWorkspaceTabs[connectionId])
  const setActiveDbTab = useAppStore((s) => s.setActiveDbTab)
  const closeDbTab = useAppStore((s) => s.closeDbTab)
  const dbTableData = useAppStore((s) => s.dbTableData)

  const [closingTabId, setClosingTabId] = useState<string | null>(null)

  const tabs = ws?.tabs ?? defaultWorkspaceTabs().tabs
  const activeTabId = ws?.activeTabId ?? DB_QUERY_TAB_ID

  // Check for unsaved edits before closing a Data tab and prompt for confirmation.
  const handleCloseTab = (tabId: string): void => {
    const edit = dbTableData[connectionId]?.[tabId]?.edit
    if (edit && isBufferDirty(edit)) {
      setClosingTabId(tabId)
    } else {
      closeDbTab(connectionId, tabId)
    }
  }

  return (
    <>
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
                      handleCloseTab(tab.tabId)
                    }}
                    onKeyDown={(event) => {
                      // Stop Enter/Space bubbling to the tab wrapper, whose handler
                      // preventDefaults the button's native click — otherwise the
                      // keyboard path re-selects the tab instead of closing it.
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.stopPropagation()
                      }
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

      {/* Confirm discard when a Data tab with unsaved edits is closed. */}
      <Dialog
        open={closingTabId !== null}
        onOpenChange={(open) => {
          if (!open) setClosingTabId(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {translate(
                'auto.components.database.DatabaseWorkspace.discardTitle',
                'Discard unsaved changes?'
              )}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'auto.components.database.DatabaseWorkspace.discardBody',
                'Closing this tab will discard unsaved edits. This cannot be undone.'
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClosingTabId(null)}>
              {translate('auto.components.database.DatabaseWorkspace.discardCancel', 'Cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (closingTabId) closeDbTab(connectionId, closingTabId)
                setClosingTabId(null)
              }}
            >
              {translate(
                'auto.components.database.DatabaseWorkspace.discardConfirm',
                'Discard and close'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
