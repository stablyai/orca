import React, { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { DbSafeError, QueryResult } from '../../../../shared/database-types'

const ROW_HEIGHT = 24
const OVERSCAN = 16
const COL_MIN_PX = 120
const COL_MAX_PX = 320

// Render a cell for display + copy. NULL is distinct from an empty string.
function formatCell(value: unknown): { text: string; isNull: boolean } {
  if (value === null || value === undefined) {
    return { text: 'NULL', isNull: true }
  }
  if (typeof value === 'object') {
    return { text: JSON.stringify(value), isNull: false }
  }
  return { text: String(value), isNull: false }
}

function copyCell(value: unknown): void {
  const { text, isNull } = formatCell(value)
  void navigator.clipboard.writeText(isNull ? '' : text)
  toast.success(translate('auto.components.database.ResultsGrid.copied', 'Copied cell'))
}

export function ResultsGrid({
  result,
  error,
  running
}: {
  result?: QueryResult
  error?: DbSafeError
  running: boolean
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const rows = result?.rows ?? []
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
    getItemKey: (index) => index
  })

  if (running) {
    return <GridPlaceholder spinning text={translate('auto.components.database.ResultsGrid.running', 'Running…')} />
  }
  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <p className="max-w-md text-center text-xs text-destructive">{error.safeMessage}</p>
      </div>
    )
  }
  if (!result) {
    return (
      <GridPlaceholder
        text={translate('auto.components.database.ResultsGrid.empty', 'Run a query to see results')}
      />
    )
  }

  const gridTemplate =
    result.columns.length > 0
      ? result.columns.map(() => `minmax(${COL_MIN_PX}px, ${COL_MAX_PX}px)`).join(' ')
      : '1fr'

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="scrollbar-sleek min-h-0 flex-1 overflow-auto">
        <div className="inline-block min-w-full font-mono text-xs">
          {/* Sticky header */}
          <div
            className="sticky top-0 z-10 grid border-b border-border bg-muted/90 backdrop-blur"
            style={{ gridTemplateColumns: gridTemplate, height: ROW_HEIGHT }}
          >
            {result.columns.map((col, i) => (
              <div
                key={`${col.name}-${i}`}
                className="flex items-center truncate border-r border-border/60 px-2 font-medium"
                title={col.dataType ? `${col.name} · ${col.dataType}` : col.name}
              >
                {col.name}
              </div>
            ))}
          </div>
          {rows.length === 0 ? (
            <div className="px-2 py-2 text-muted-foreground">
              {translate('auto.components.database.ResultsGrid.noRows', 'No rows returned')}
            </div>
          ) : (
            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => {
                const row = rows[item.index]
                return (
                  <div
                    key={item.key}
                    className="absolute left-0 top-0 grid w-full border-b border-border/40 hover:bg-accent/40"
                    style={{
                      gridTemplateColumns: gridTemplate,
                      height: ROW_HEIGHT,
                      transform: `translateY(${item.start}px)`
                    }}
                  >
                    {result.columns.map((_col, ci) => {
                      const { text, isNull } = formatCell(row?.[ci])
                      return (
                        <button
                          key={ci}
                          type="button"
                          onClick={() => copyCell(row?.[ci])}
                          title={text}
                          className={`truncate border-r border-border/40 px-2 text-left ${
                            isNull ? 'italic text-muted-foreground/60' : ''
                          }`}
                        >
                          {text}
                        </button>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        <span>
          {translate('auto.components.database.ResultsGrid.rowCount', '{{count}} rows', {
            count: result.rowCount
          })}
        </span>
        <span>
          {translate('auto.components.database.ResultsGrid.durationMs', '{{ms}} ms', {
            ms: result.durationMs
          })}
        </span>
        {result.truncated ? (
          <span className="text-amber-600 dark:text-amber-500">
            {translate(
              'auto.components.database.ResultsGrid.truncated',
              'Truncated — showing the first rows'
            )}
          </span>
        ) : null}
      </div>
    </div>
  )
}

function GridPlaceholder({ text, spinning }: { text: string; spinning?: boolean }): React.JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center gap-2 p-6">
      {spinning ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
      <p className="text-xs text-muted-foreground">{text}</p>
    </div>
  )
}
