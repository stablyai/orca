import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ChevronRight,
  Columns3,
  Database,
  Eye,
  KeyRound,
  Loader2,
  RefreshCw,
  Table2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { dbColumnKey } from '@/store/slices/database'
import { translate } from '@/i18n/i18n'
import { buildSchemaRows, type NodeLoadState, type SchemaTreeRow } from './schema-tree-rows'

const ROW_HEIGHT = 26
const OVERSCAN = 12
const INDENT_PX = 14
const BASE_PAD_PX = 8

type RootState = 'idle' | 'loading' | 'error'

// Toggle a value in a Set immutably (new Set so React sees the change).
function toggleSet(set: ReadonlySet<string>, value: string): Set<string> {
  const next = new Set(set)
  if (!next.delete(value)) {
    next.add(value)
  }
  return next
}

export function SchemaTree({ connectionId }: { connectionId: string }): React.JSX.Element {
  const cache = useAppStore((s) => s.dbSchemaCache[connectionId])
  const status = useAppStore((s) => s.dbStatuses[connectionId]?.status ?? 'idle')
  const loadDbSchemas = useAppStore((s) => s.loadDbSchemas)
  const loadDbSchemaTables = useAppStore((s) => s.loadDbSchemaTables)
  const loadDbTableColumns = useAppStore((s) => s.loadDbTableColumns)
  const previewDbTable = useAppStore((s) => s.previewDbTable)

  const [expandedSchemas, setExpandedSchemas] = useState<ReadonlySet<string>>(new Set())
  const [expandedTables, setExpandedTables] = useState<ReadonlySet<string>>(new Set())
  const [nodeState, setNodeState] = useState<Record<string, NodeLoadState>>({})
  const [rootState, setRootState] = useState<RootState>('idle')
  const [selectedIndex, setSelectedIndex] = useState(0)

  const scrollRef = useRef<HTMLDivElement>(null)

  const runRootLoad = useCallback(() => {
    setRootState('loading')
    void loadDbSchemas(connectionId).then((result) => {
      setRootState(result.ok ? 'idle' : 'error')
    })
  }, [connectionId, loadDbSchemas])

  // Load the schema list once the connection is live and nothing is cached yet.
  useEffect(() => {
    if (status === 'connected' && !cache && rootState === 'idle') {
      runRootLoad()
    }
  }, [status, cache, rootState, runRootLoad])

  const refresh = useCallback(() => {
    setExpandedSchemas(new Set())
    setExpandedTables(new Set())
    setNodeState({})
    runRootLoad()
  }, [runRootLoad])

  // Expand a schema (lazy-loading its tables) or collapse it.
  const toggleSchema = useCallback(
    (schema: string) => {
      setExpandedSchemas((prev) => toggleSet(prev, schema))
      if (expandedSchemas.has(schema) || cache?.tables[schema]) {
        return
      }
      setNodeState((prev) => ({ ...prev, [schema]: 'loading' }))
      void loadDbSchemaTables(connectionId, schema).then((result) => {
        setNodeState((prev) => {
          const next = { ...prev }
          if (result.ok) {
            delete next[schema]
          } else {
            next[schema] = 'error'
          }
          return next
        })
      })
    },
    [cache, connectionId, expandedSchemas, loadDbSchemaTables]
  )

  const toggleTable = useCallback(
    (schema: string, table: string) => {
      const key = dbColumnKey(schema, table)
      setExpandedTables((prev) => toggleSet(prev, key))
      if (expandedTables.has(key) || cache?.columns[key]) {
        return
      }
      setNodeState((prev) => ({ ...prev, [key]: 'loading' }))
      void loadDbTableColumns(connectionId, schema, table).then((result) => {
        setNodeState((prev) => {
          const next = { ...prev }
          if (result.ok) {
            delete next[key]
          } else {
            next[key] = 'error'
          }
          return next
        })
      })
    },
    [cache, connectionId, expandedTables, loadDbTableColumns]
  )

  const rows: SchemaTreeRow[] = useMemo(
    () => (cache ? buildSchemaRows(cache, expandedSchemas, expandedTables, nodeState) : []),
    [cache, expandedSchemas, expandedTables, nodeState]
  )

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
    getItemKey: (index) => rows[index]?.key ?? index
  })

  // Expand/collapse a schema or table (tables/columns lazy-load on first open).
  // Bound to the chevron and the Arrow keys so it stays separate from a row's
  // primary action.
  const toggleExpand = useCallback(
    (row: SchemaTreeRow) => {
      if (row.type === 'schema') {
        toggleSchema(row.schema)
      } else if (row.type === 'table') {
        toggleTable(row.schema, row.table.name)
      }
    },
    [toggleSchema, toggleTable]
  )

  // A row's primary action (click / Enter): schemas expand; a table/view loads
  // its first rows into the editor and runs them.
  const activateRow = useCallback(
    (row: SchemaTreeRow) => {
      if (row.type === 'schema') {
        toggleSchema(row.schema)
      } else if (row.type === 'table') {
        void previewDbTable(connectionId, row.schema, row.table.name)
      }
    },
    [connectionId, previewDbTable, toggleSchema]
  )

  const moveSelection = useCallback(
    (delta: number) => {
      setSelectedIndex((prev) => {
        const next = Math.max(0, Math.min(rows.length - 1, prev + delta))
        virtualizer.scrollToIndex(next, { align: 'auto' })
        return next
      })
    },
    [rows.length, virtualizer]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const row = rows[selectedIndex]
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault()
          moveSelection(1)
          break
        case 'ArrowUp':
          event.preventDefault()
          moveSelection(-1)
          break
        case 'ArrowRight':
          if (row && (row.type === 'schema' || row.type === 'table') && !row.expanded) {
            event.preventDefault()
            toggleExpand(row)
          }
          break
        case 'ArrowLeft':
          if (row && (row.type === 'schema' || row.type === 'table') && row.expanded) {
            event.preventDefault()
            toggleExpand(row)
          }
          break
        case 'Enter':
          if (row) {
            event.preventDefault()
            activateRow(row)
          }
          break
        default:
          break
      }
    },
    [rows, selectedIndex, moveSelection, activateRow, toggleExpand]
  )

  if (status !== 'connected') {
    return <TreePlaceholder text={disconnectedMessage(status)} />
  }
  if (rootState === 'loading' && !cache) {
    return <TreePlaceholder text={translate('auto.components.database.SchemaTree.loading', 'Loading schema…')} spinning />
  }
  if (rootState === 'error' && !cache) {
    return (
      <TreePlaceholder
        text={translate('auto.components.database.SchemaTree.loadError', 'Could not read the schema')}
        onRetry={refresh}
      />
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground">
          {translate('auto.components.database.SchemaTree.title', 'Schema')}
        </span>
        <Button type="button" variant="ghost" size="icon-sm" onClick={refresh}>
          <RefreshCw className={`size-3.5 ${rootState === 'loading' ? 'animate-spin' : ''}`} />
          <span className="sr-only">
            {translate('auto.components.database.SchemaTree.refresh', 'Refresh')}
          </span>
        </Button>
      </div>
      {rows.length === 0 ? (
        <TreePlaceholder
          text={translate('auto.components.database.SchemaTree.empty', 'No schemas')}
        />
      ) : (
        <div
          ref={scrollRef}
          role="tree"
          tabIndex={0}
          onKeyDown={handleKeyDown}
          className="scrollbar-sleek min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const row = rows[virtualItem.index]
              return (
                <div
                  key={virtualItem.key}
                  className="absolute left-0 top-0 w-full"
                  style={{ height: ROW_HEIGHT, transform: `translateY(${virtualItem.start}px)` }}
                >
                  <SchemaRowView
                    row={row}
                    selected={virtualItem.index === selectedIndex}
                    onSelect={() => setSelectedIndex(virtualItem.index)}
                    onActivate={() => activateRow(row)}
                    onToggleExpand={() => toggleExpand(row)}
                  />
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function disconnectedMessage(status: string): string {
  return status === 'lost'
    ? translate('auto.components.database.SchemaTree.lost', 'Connection lost — reconnect to browse')
    : translate('auto.components.database.SchemaTree.notConnected', 'Connect to browse the schema')
}

function TreePlaceholder({
  text,
  spinning,
  onRetry
}: {
  text: string
  spinning?: boolean
  onRetry?: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      {spinning ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
      <p className="text-xs text-muted-foreground">{text}</p>
      {onRetry ? (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {translate('auto.components.database.SchemaTree.retry', 'Retry')}
        </Button>
      ) : null}
    </div>
  )
}

function SchemaRowView({
  row,
  selected,
  onSelect,
  onActivate,
  onToggleExpand
}: {
  row: SchemaTreeRow
  selected: boolean
  onSelect: () => void
  onActivate: () => void
  onToggleExpand: () => void
}): React.JSX.Element {
  const padLeft = BASE_PAD_PX + row.depth * INDENT_PX
  const selectedClass = selected ? 'bg-accent' : 'hover:bg-accent/50'
  return (
    <div
      role="treeitem"
      aria-selected={selected}
      onMouseDown={onSelect}
      onClick={onActivate}
      style={{ paddingLeft: padLeft }}
      className={`flex h-full cursor-default items-center gap-1.5 pr-3 text-xs ${selectedClass}`}
    >
      <RowContent row={row} onToggleExpand={onToggleExpand} />
    </div>
  )
}

function RowContent({
  row,
  onToggleExpand
}: {
  row: SchemaTreeRow
  onToggleExpand: () => void
}): React.JSX.Element {
  if (row.type === 'schema') {
    return (
      <>
        <Chevron expanded={row.expanded} onToggle={onToggleExpand} />
        <Database className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium">{row.schema}</span>
      </>
    )
  }
  if (row.type === 'table') {
    const Icon = row.table.kind === 'view' ? Eye : Table2
    return (
      <>
        <Chevron expanded={row.expanded} onToggle={onToggleExpand} />
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{row.table.name}</span>
      </>
    )
  }
  if (row.type === 'column') {
    return (
      <>
        <span className="w-3.5 shrink-0" />
        <Columns3 className="size-3.5 shrink-0 text-muted-foreground/70" />
        <span className="truncate">{row.column.name}</span>
        {row.column.isPrimaryKey ? (
          <KeyRound className="size-3 shrink-0 text-amber-500" aria-hidden="true" />
        ) : null}
        <span className="ml-1 truncate font-mono text-[10px] text-muted-foreground">
          {row.column.dataType}
          {row.column.nullable
            ? null
            : ` · ${translate('auto.components.database.SchemaTree.notNull', 'not null')}`}
        </span>
      </>
    )
  }
  return <MessageRow variant={row.variant} />
}

function MessageRow({
  variant
}: {
  variant: 'loading' | 'error' | 'empty' | 'overflow'
}): React.JSX.Element {
  if (variant === 'loading') {
    return (
      <span className="flex items-center gap-1.5 pl-5 text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        {translate('auto.components.database.SchemaTree.loading', 'Loading schema…')}
      </span>
    )
  }
  const text =
    variant === 'error'
      ? translate('auto.components.database.SchemaTree.nodeError', 'Failed to load')
      : variant === 'overflow'
        ? translate(
            'auto.components.database.SchemaTree.overflow',
            'Too many objects — refine the connection'
          )
        : translate('auto.components.database.SchemaTree.noItems', 'Empty')
  return <span className="pl-5 italic text-muted-foreground">{text}</span>
}

function Chevron({
  expanded,
  onToggle
}: {
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <span
      // Toggle expansion without firing the row's primary action (a table row
      // previews its rows on click, so its chevron must own expand/collapse).
      onClick={(event) => {
        event.stopPropagation()
        onToggle()
      }}
      className="flex size-3.5 shrink-0 items-center justify-center"
      aria-hidden="true"
    >
      <ChevronRight
        className={`size-3.5 text-muted-foreground transition-transform ${
          expanded ? 'rotate-90' : ''
        }`}
      />
    </span>
  )
}
