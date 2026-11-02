import { useEffect, useId, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, ArrowUp, ArrowUpDown, Check } from 'lucide-react'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { translate } from '@/i18n/i18n'
import type { PluginDeclarativeProps } from '../../../../../shared/plugins/declarative/plugin-declarative-catalog'
import { usePluginDeclarativeHostValue } from './plugin-declarative-host-value'
import type { PluginDeclarativeEmit } from './PluginDeclarativeControls'
import { nextTableRow, nextTableSelection } from './plugin-declarative-table-selection'
import { PluginDeclarativeRelativeTimeText } from './PluginDeclarativeRelativeTime'
import {
  PLUGIN_TABLE_MIN_WIDTHS,
  pluginTableVisibleColumns
} from '../../../../../shared/plugins/declarative/plugin-declarative-table-columns'

type TableProps = PluginDeclarativeProps<'Table'>
type Column = TableProps['columns'][number]
type Cell = TableProps['rows'][number]['cells'][string]

const ROW_HEIGHT = 32
// Rows from the end that ask for more, so the next page lands before the person reaches it.
const LOAD_MORE_THRESHOLD = 10
const COLUMN_WIDTH: Record<NonNullable<Column['width']>, string> = {
  auto: 'minmax(0,1fr)',
  xs: '4rem',
  sm: '6rem',
  md: '9rem',
  lg: '14rem'
}
const IS_MAC = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')

function CellValue({ value }: { value: Cell | undefined }): React.ReactNode {
  if (value === true) {
    return (
      <Check
        className="size-4"
        aria-label={translate('auto.components.plugins.declarative.Table.yes', 'Yes')}
      />
    )
  }
  if (typeof value === 'object' && value !== null) {
    return (
      <span className="truncate">
        <PluginDeclarativeRelativeTimeText at={value.at} format={value.format} />
      </span>
    )
  }
  if (value === false || value === null || value === undefined || value === '') {
    return <span className="text-muted-foreground">{value === false ? '' : '–'}</span>
  }
  // The full text on hover, since narrow columns cut it.
  return (
    <span className="truncate" title={String(value)}>
      {String(value)}
    </span>
  )
}

function SortGlyph({ direction }: { direction: 'asc' | 'desc' | null }): React.JSX.Element {
  const Glyph = direction === 'asc' ? ArrowUp : direction === 'desc' ? ArrowDown : ArrowUpDown
  return <Glyph aria-hidden className="size-3 shrink-0" />
}

/**
 * Rows scroll inside the table and only those in view are drawn. Focus stays on the grid and arrow
 * keys move an active row (announced through aria-activedescendant), so virtual rows need no focus.
 */
export function PluginDeclarativeTable({
  props,
  emit
}: {
  props: TableProps
  emit: PluginDeclarativeEmit
}): React.JSX.Element {
  const id = useId()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const mode = props.selectionMode ?? 'none'
  const { rows } = props
  const rootRef = useRef<HTMLDivElement | null>(null)
  // Infinity until measured, so a table first draws every column (and tests without layout do).
  const [width, setWidth] = useState(Number.POSITIVE_INFINITY)
  useEffect(() => {
    const root = rootRef.current
    if (!root || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) {
        setWidth(entry.contentRect.width)
      }
    })
    observer.observe(root)
    return () => observer.disconnect()
  }, [])
  const columns = pluginTableVisibleColumns(props.columns, width)
  const keys = rows.map((row) => row.key)
  const selectionCallback = props.onSelectionChange?.$callback
  const selection = usePluginDeclarativeHostValue<readonly string[]>({
    value: props.selected,
    defaultValue: props.defaultSelected,
    fallback: [],
    acked: props.$edit,
    actTarget: props,
    callback: selectionCallback,
    send: (callback, value, edit) => emit(callback, [{ keys: [...value] }], { edit })
  })
  const [active, setActive] = useState(0)
  const [anchor, setAnchor] = useState<string | null>(null)
  // The rows a load-more request was made for; a new sort or filter (another first row) is a new list.
  const requestedFor = useRef<string | null>(null)
  const activeIndex = Math.min(active, Math.max(0, rows.length - 1))
  const showLoading =
    props.loading === true || (props.hasMore === true && props.onLoadMore !== undefined)
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rows.length + (showLoading ? 1 : 0),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => rows[index]?.key ?? '#loading',
    overscan: 8
  })
  const items = virtualizer.getVirtualItems()
  const lastShown = items.at(-1)?.index ?? -1
  const loadMore = props.onLoadMore?.$callback
  const listSignature = `${rows.length}:${rows[0]?.key ?? ''}`
  // Pull-based paging: ask once per list of `rows`, when the end comes near.
  useEffect(() => {
    if (
      loadMore &&
      props.hasMore &&
      !props.loading &&
      lastShown >= rows.length - LOAD_MORE_THRESHOLD &&
      requestedFor.current !== listSignature
    ) {
      requestedFor.current = listSignature
      emit(loadMore, [])
    }
  }, [emit, lastShown, listSignature, loadMore, props.hasMore, props.loading, rows.length])

  const template = columns
    .map((column) =>
      (column.width ?? 'auto') === 'auto'
        ? `minmax(${PLUGIN_TABLE_MIN_WIDTHS[column.minWidth ?? 'auto']},1fr)`
        : COLUMN_WIDTH[column.width ?? 'auto']
    )
    .join(' ')
  const select = (key: string, toggle: boolean, extend: boolean): void => {
    const row = rows.find((entry) => entry.key === key)
    if (mode === 'none' || !row || row.disabled) {
      return
    }
    selection.change(
      nextTableSelection({ mode, selected: selection.value, keys, key, toggle, extend, anchor })
    )
    if (!extend) {
      setAnchor(key)
    }
  }
  const act = (key: string): void => {
    const action = props.onRowAction?.$callback
    if (action && !rows.find((row) => row.key === key)?.disabled) {
      emit(action, [{ key }])
    }
  }
  const sortBy = (column: Column): void => {
    const callback = props.onSortChange?.$callback
    if (!callback || !column.sortable) {
      return
    }
    const direction =
      props.sort?.column === column.key && props.sort.direction === 'asc' ? 'desc' : 'asc'
    emit(callback, [{ column: column.key, direction }])
  }

  return (
    <div
      ref={rootRef}
      role="grid"
      aria-label={props.label}
      aria-rowcount={rows.length + 1}
      aria-colcount={columns.length}
      aria-multiselectable={mode === 'multiple' || undefined}
      aria-activedescendant={rows.length > 0 ? `${id}-row-${activeIndex}` : undefined}
      tabIndex={0}
      className="group/grid flex min-w-0 flex-col overflow-hidden rounded-md border border-border text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      onKeyDown={(event) => {
        const row = rows[activeIndex]
        if (event.key === 'Enter' && row) {
          event.preventDefault()
          act(row.key)
          return
        }
        if (event.key === ' ' && row) {
          event.preventDefault()
          select(row.key, true, false)
          return
        }
        const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 0) / ROW_HEIGHT))
        const next = nextTableRow(event.key, activeIndex, rows.length, page)
        if (next !== null) {
          event.preventDefault()
          setActive(next)
          virtualizer.scrollToIndex(next)
          if (event.shiftKey && rows[next]) {
            select(rows[next].key, false, true)
          }
        }
      }}
    >
      <div
        role="row"
        aria-rowindex={1}
        className="grid border-b border-border bg-muted/50"
        style={{ gridTemplateColumns: template }}
      >
        {columns.map((column) => {
          const direction = props.sort?.column === column.key ? props.sort.direction : null
          return (
            <div
              key={column.key}
              role="columnheader"
              aria-sort={
                direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : undefined
              }
              data-align={column.align ?? 'start'}
              className="flex h-8 min-w-0 items-center px-2 text-2xs font-semibold tracking-wider text-muted-foreground uppercase data-[align=center]:justify-center data-[align=end]:justify-end"
            >
              {column.sortable && props.onSortChange ? (
                <button
                  type="button"
                  tabIndex={-1}
                  className="flex min-w-0 cursor-pointer items-center gap-1 uppercase hover:text-foreground"
                  onClick={() => sortBy(column)}
                >
                  <span className="truncate" title={column.label}>
                    {column.label}
                  </span>
                  <SortGlyph direction={direction} />
                </button>
              ) : (
                <span className="truncate" title={column.label}>
                  {column.label}
                </span>
              )}
            </div>
          )
        })}
      </div>
      <div
        ref={scrollRef}
        data-max-height={props.maxHeight ?? 'md'}
        className="scrollbar-sleek relative min-h-0 overflow-y-auto data-[max-height=lg]:max-h-[32rem] data-[max-height=md]:max-h-96 data-[max-height=sm]:max-h-64"
      >
        {rows.length === 0 && !showLoading ? (
          <div className="px-2 py-3 text-center text-muted-foreground">
            {props.emptyText ??
              translate('auto.components.plugins.declarative.Table.empty', 'No rows')}
          </div>
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {items.map((item) => {
              const row = rows[item.index]
              if (!row) {
                return (
                  <div
                    key={item.key}
                    role="row"
                    className="absolute inset-x-0 flex items-center gap-2 px-2 text-muted-foreground"
                    style={{ top: item.start, height: ROW_HEIGHT }}
                  >
                    <LoadingSpinner className="size-3.5" />
                    {translate(
                      'auto.components.plugins.declarative.Table.loading',
                      'Loading more…'
                    )}
                  </div>
                )
              }
              const isSelected = selection.value.includes(row.key)
              return (
                <div
                  key={item.key}
                  id={`${id}-row-${item.index}`}
                  role="row"
                  aria-rowindex={item.index + 2}
                  aria-selected={mode === 'none' ? undefined : isSelected}
                  aria-disabled={row.disabled || undefined}
                  data-current={isSelected}
                  data-active={item.index === activeIndex}
                  className="absolute inset-x-0 grid cursor-default items-center border-b border-border/60 hover:bg-accent group-focus-visible/grid:data-[active=true]:ring-1 group-focus-visible/grid:data-[active=true]:ring-ring/40 group-focus-visible/grid:data-[active=true]:ring-inset data-[current=true]:bg-accent aria-disabled:opacity-50"
                  style={{ top: item.start, height: ROW_HEIGHT, gridTemplateColumns: template }}
                  onClick={(event) => {
                    setActive(item.index)
                    select(row.key, IS_MAC ? event.metaKey : event.ctrlKey, event.shiftKey)
                  }}
                  onDoubleClick={() => act(row.key)}
                >
                  {columns.map((column) => (
                    <div
                      key={column.key}
                      role="gridcell"
                      data-align={column.align ?? 'start'}
                      className="flex min-w-0 items-center px-2 text-foreground data-[align=center]:justify-center data-[align=end]:justify-end data-[align=end]:tabular-nums"
                    >
                      <CellValue value={row.cells[column.key]} />
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
