import { useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { translate } from '@/i18n/i18n'
import type { PluginDeclarativeProps } from '../../../../../shared/plugins/declarative/plugin-declarative-catalog'
import { usePluginDeclarativeHostValue } from './plugin-declarative-host-value'
import { usePluginDeclarativeActExpansion } from './plugin-declarative-act-targets'
import type { PluginDeclarativeEmit } from './PluginDeclarativeControls'
import { PluginDeclarativeIconGlyph } from './plugin-declarative-icons'
import { visibleTreeRows, type PluginDeclarativeTreeRow } from './plugin-declarative-tree-rows'

type ItemRow = Extract<PluginDeclarativeTreeRow, { kind: 'item' }>

/** A WAI-ARIA tree: one tab stop, arrow keys move, expand and collapse, Enter acts. */
export function PluginDeclarativeTree({
  props,
  emit
}: {
  props: PluginDeclarativeProps<'Tree'>
  emit: PluginDeclarativeEmit
}): React.JSX.Element {
  // `expanded` is the plugin's record; a toggle shows at once and a changed list replaces it.
  const controlled = props.expanded?.join('\u0000')
  const [openItems, setOpenItems] = useState(() => ({
    controlled,
    keys: new Set(props.expanded ?? props.defaultExpanded ?? [])
  }))
  let expanded: ReadonlySet<string> = openItems.keys
  if (props.expanded && openItems.controlled !== controlled) {
    const next = { controlled, keys: new Set(props.expanded) }
    setOpenItems(next)
    expanded = next.keys
  }
  const selection = usePluginDeclarativeHostValue({
    value: props.selected,
    defaultValue: props.defaultSelected,
    fallback: '',
    acked: props.$edit,
    actTarget: props,
    callback: props.onSelect?.$callback,
    send: (callback, key, edit) => emit(callback, [{ key }], { edit })
  })
  const [focused, setFocused] = useState<string | null>(null)
  const elements = useRef(new Map<string, HTMLElement>())
  const rows = visibleTreeRows(props.items, expanded)
  const items = rows.filter((row): row is ItemRow => row.kind === 'item')
  const tabStop = items.find((row) => row.item.key === (focused ?? selection.value)) ?? items[0]

  const focus = (row: ItemRow | undefined): void => {
    if (row) {
      setFocused(row.item.key)
      elements.current.get(row.item.key)?.focus()
    }
  }
  const setExpanded = (key: string, open: boolean): void => {
    setOpenItems((previous) => {
      const keys = new Set(previous.keys)
      if (open) {
        keys.add(key)
      } else {
        keys.delete(key)
      }
      return { ...previous, keys }
    })
    const callback = props.onToggle?.$callback
    if (callback) {
      emit(callback, [{ key, expanded: open }])
    }
  }
  usePluginDeclarativeActExpansion(props, { expanded: () => expanded, set: setExpanded })
  const toggle = (row: ItemRow, open: boolean): void => {
    if (row.expandable && row.expanded !== open) {
      setExpanded(row.item.key, open)
    }
  }
  const select = (row: ItemRow): void => {
    if (!row.item.disabled && selection.value !== row.item.key) {
      selection.change(row.item.key)
    }
  }
  const act = (row: ItemRow): void => {
    const callback = props.onAction?.$callback
    if (callback && !row.item.disabled) {
      emit(callback, [{ key: row.item.key }])
    }
  }
  const onKeyDown = (event: React.KeyboardEvent, row: ItemRow): void => {
    const index = items.indexOf(row)
    const handlers: Record<string, () => void> = {
      ArrowDown: () => focus(items[index + 1]),
      ArrowUp: () => focus(items[index - 1]),
      Home: () => focus(items[0]),
      End: () => focus(items.at(-1)),
      ArrowRight: () => (row.expanded ? focus(items[index + 1]) : toggle(row, true)),
      ArrowLeft: () =>
        row.expanded ? toggle(row, false) : focus(items.find((r) => r.item.key === row.parent)),
      Enter: () => act(row),
      ' ': () => select(row)
    }
    const handler = handlers[event.key]
    if (handler) {
      event.preventDefault()
      handler()
    }
  }

  return (
    <div
      role="tree"
      aria-label={props.label}
      data-max-height={props.maxHeight ?? 'none'}
      className="scrollbar-sleek flex min-w-0 flex-col overflow-y-auto text-sm data-[max-height=lg]:max-h-[32rem] data-[max-height=md]:max-h-96 data-[max-height=sm]:max-h-64"
    >
      {rows.map((row) =>
        row.kind === 'loading' ? (
          <div
            key={row.key}
            role="none"
            data-level={Math.min(row.level, 8)}
            className="flex h-7 items-center gap-2 text-xs text-muted-foreground"
            style={{ paddingLeft: `${(row.level - 1) * 12 + 28}px` }}
          >
            <LoadingSpinner className="size-3.5" />
            {translate('auto.components.plugins.declarative.Tree.loading', 'Loading…')}
          </div>
        ) : (
          <div
            key={row.item.key}
            ref={(element) => {
              if (element) {
                elements.current.set(row.item.key, element)
              } else {
                elements.current.delete(row.item.key)
              }
            }}
            role="treeitem"
            aria-level={row.level}
            aria-expanded={row.expandable ? row.expanded : undefined}
            aria-selected={selection.value === row.item.key}
            aria-disabled={row.item.disabled || undefined}
            tabIndex={row === tabStop ? 0 : -1}
            data-current={selection.value === row.item.key}
            className="flex h-7 min-w-0 cursor-pointer items-center gap-1 rounded-md pr-2 outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 data-[current=true]:bg-accent"
            style={{ paddingLeft: `${(row.level - 1) * 12 + 4}px` }}
            onFocus={() => setFocused(row.item.key)}
            onKeyDown={(event) => onKeyDown(event, row)}
            onClick={() => select(row)}
            onDoubleClick={() => act(row)}
          >
            <span
              aria-hidden
              className="flex size-5 shrink-0 items-center justify-center text-muted-foreground"
              onClick={(event) => {
                if (row.expandable) {
                  event.stopPropagation()
                  toggle(row, !row.expanded)
                }
              }}
            >
              {row.expandable ? (
                <ChevronRight
                  data-expanded={row.expanded}
                  className="size-4 transition-transform data-[expanded=true]:rotate-90 motion-reduce:transition-none"
                />
              ) : null}
            </span>
            {row.item.icon ? (
              <PluginDeclarativeIconGlyph
                name={row.item.icon}
                className="size-4 shrink-0 text-muted-foreground"
              />
            ) : null}
            <span className="truncate text-foreground">{row.item.label}</span>
            {row.item.description ? (
              <span className="truncate text-xs text-muted-foreground">{row.item.description}</span>
            ) : null}
          </div>
        )
      )}
    </div>
  )
}
