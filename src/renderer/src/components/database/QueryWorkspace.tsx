import React, { useCallback, useState } from 'react'
import { Loader2, Play, Square } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
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
import { needsWriteConfirm } from '../../../../shared/sql-statement-classifier'
import { setColumnFilter } from './data-grid-filters'
import { QueryEditor } from './QueryEditor'
import { ResultsGrid } from './ResultsGrid'

export function QueryWorkspace({ connectionId }: { connectionId: string }): React.JSX.Element {
  const text = useAppStore((s) => s.dbQueryText[connectionId] ?? '')
  const queryState = useAppStore((s) => s.dbQueryState[connectionId])
  const readOnly = useAppStore(
    (s) => s.dbConnections.find((c) => c.id === connectionId)?.readOnly ?? false
  )
  const setDbQueryText = useAppStore((s) => s.setDbQueryText)
  const runDbQuery = useAppStore((s) => s.runDbQuery)
  const cancelDbQuery = useAppStore((s) => s.cancelDbQuery)
  const setDbQuerySort = useAppStore((s) => s.setDbQuerySort)
  const setDbQueryFilters = useAppStore((s) => s.setDbQueryFilters)
  const setDbQueryPage = useAppStore((s) => s.setDbQueryPage)

  const running = queryState?.running ?? false
  const [pendingSql, setPendingSql] = useState<string | null>(null)

  const execute = useCallback(
    (sql: string) => {
      void runDbQuery(connectionId, sql)
    },
    [connectionId, runDbQuery]
  )

  const handleRun = useCallback(() => {
    const sql = text.trim()
    if (!sql || running) {
      return
    }
    // Writable connections have no DB backstop, so a destructive/ambiguous
    // statement must be confirmed first (read-only connections are DB-enforced).
    if (!readOnly && needsWriteConfirm(sql)) {
      setPendingSql(sql)
      return
    }
    execute(sql)
  }, [text, running, readOnly, execute])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        {running ? (
          <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => void cancelDbQuery(connectionId)}>
            <Square className="size-3.5" />
            {translate('auto.components.database.QueryWorkspace.cancel', 'Cancel')}
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            className="gap-1.5"
            disabled={text.trim().length === 0}
            onClick={handleRun}
          >
            <Play className="size-3.5" />
            {translate('auto.components.database.QueryWorkspace.run', 'Run')}
          </Button>
        )}
        {running ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
        {readOnly ? (
          <Badge variant="outline" className="h-5 text-[10px]">
            {translate('auto.components.database.QueryWorkspace.readOnly', 'Read-only')}
          </Badge>
        ) : null}
        <span className="ml-auto text-[11px] text-muted-foreground">
          {translate('auto.components.database.QueryWorkspace.runHint', '{{mod}} + Enter to run', {
            // Show the platform's real run-shortcut modifier (⌘ on Mac, Ctrl elsewhere).
            mod: navigator.userAgent.includes('Mac') ? '⌘' : 'Ctrl'
          })}
        </span>
      </div>

      <div className="h-[42%] min-h-[120px] border-b border-border">
        <QueryEditor
          value={text}
          onChange={(next) => setDbQueryText(connectionId, next)}
          onRunShortcut={handleRun}
        />
      </div>

      <ResultsGrid
        result={queryState?.result}
        error={queryState?.error}
        running={running}
        refine={
          queryState?.refine
            ? {
                refine: queryState.refine,
                onSort: (ordinal) => setDbQuerySort(connectionId, ordinal),
                onFilter: (column, filter) =>
                  setDbQueryFilters(
                    connectionId,
                    setColumnFilter(queryState.refine?.filters ?? [], column, filter)
                  ),
                onPage: (delta) => setDbQueryPage(connectionId, delta)
              }
            : undefined
        }
      />

      <Dialog open={pendingSql !== null} onOpenChange={(open) => !open && setPendingSql(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {translate('auto.components.database.QueryWorkspace.confirmTitle', 'Run this statement?')}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'auto.components.database.QueryWorkspace.confirmBody',
                'This looks like it may modify data or schema. Run it against a writable connection?'
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingSql(null)}>
              {translate('auto.components.database.QueryWorkspace.confirmCancel', 'Cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (pendingSql) {
                  execute(pendingSql)
                }
                setPendingSql(null)
              }}
            >
              {translate('auto.components.database.QueryWorkspace.confirmRun', 'Run statement')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
