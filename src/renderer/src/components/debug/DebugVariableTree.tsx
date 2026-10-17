import { useEffect, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { ImeInput } from '@/lib/ime-text-field'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { DebugVariableWire, DebugWorktree } from '../../../../preload/api/debug-api'
import { debugErrorMessage, type DebugSectionsClient } from './debug-section-contract'

export const DEBUG_VARIABLE_PAGE = 100

export type DebugVariableTreeContext = {
  client: DebugSectionsClient
  target: DebugWorktree
  canSetVariable: boolean
  expanded: ReadonlySet<string>
  onToggle: (path: string) => void
}

type ChildrenProps = {
  context: DebugVariableTreeContext
  variablesReference: number
  /** named + indexed children, when the adapter reported them. */
  total?: number
  path: string
  depth: number
}

export function childTotal(item: { namedVariables?: number; indexedVariables?: number }) {
  return item.namedVariables === undefined && item.indexedVariables === undefined
    ? undefined
    : (item.namedVariables ?? 0) + (item.indexedVariables ?? 0)
}

const indent = (depth: number) => ({ paddingLeft: `${depth * 12 + 8}px` })

/** Fetched on mount, which happens only when the parent is expanded. */
export function DebugVariableChildren({
  context,
  variablesReference,
  total,
  path,
  depth
}: ChildrenProps): React.JSX.Element {
  const { client, target } = context
  const [rows, setRows] = useState<DebugVariableWire[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [shown, setShown] = useState(DEBUG_VARIABLE_PAGE)
  const [loadingMore, setLoadingMore] = useState(false)
  // A ref, not state: a second click can land before the disabled render.
  const pagePending = useRef(false)
  // Ask for pages only when the adapter says there are more than one page of children.
  const paged = total !== undefined && total > DEBUG_VARIABLE_PAGE

  useEffect(() => {
    let current = true
    setRows(null)
    setError(null)
    setShown(DEBUG_VARIABLE_PAGE)
    const page = paged ? { start: 0, count: DEBUG_VARIABLE_PAGE } : {}
    client
      .variables({ ...target, variablesReference, ...page })
      .then((result) => {
        if (current) {
          if (result.ok) {
            setRows(result.value)
          } else {
            setError(result.message)
          }
        }
      })
      .catch((caught: unknown) => {
        if (current) {
          setError(debugErrorMessage(caught))
        }
      })
    return () => {
      current = false
    }
  }, [client, target, variablesReference, paged])

  if (error !== null) {
    return (
      <div role="alert" className="py-0.5 text-destructive" style={indent(depth)}>
        {error}
      </div>
    )
  }
  if (rows === null) {
    return (
      <div className="py-0.5 text-muted-foreground" style={indent(depth)}>
        {translate('debug.variables.loading', 'Loading…')}
      </div>
    )
  }
  const hasMore = shown < rows.length || (paged && rows.length < (total ?? 0))
  const showMore = async (): Promise<void> => {
    if (pagePending.current) {
      return
    }
    if (shown >= rows.length) {
      pagePending.current = true
      setLoadingMore(true)
      try {
        const result = await client.variables({
          ...target,
          variablesReference,
          start: rows.length,
          count: DEBUG_VARIABLE_PAGE
        })
        if (!result.ok) {
          setError(result.message)
          return
        }
        setRows((previous) => (previous ? [...previous, ...result.value] : previous))
      } catch (caught) {
        setError(debugErrorMessage(caught))
        return
      } finally {
        pagePending.current = false
        setLoadingMore(false)
      }
    }
    setShown((previous) => previous + DEBUG_VARIABLE_PAGE)
  }
  // Adapters can repeat a name (shadowed locals), so a repeat gets its occurrence number.
  const seen = new Map<string, number>()
  const rowKeys = rows.map(({ name }) => {
    const n = seen.get(name) ?? 0
    seen.set(name, n + 1)
    return n === 0 ? name : `${name}#${n}`
  })
  const replace = (index: number, variable: DebugVariableWire): void =>
    setRows(rows.map((row, i) => (i === index ? variable : row)))

  return (
    <ul>
      {rows.slice(0, shown).map((variable, index) => (
        <DebugVariableRow
          key={rowKeys[index]}
          context={context}
          variable={variable}
          parentReference={variablesReference}
          path={`${path}/${variable.name}`}
          depth={depth}
          onUpdated={(next) => replace(index, next)}
        />
      ))}
      {hasMore ? (
        <button
          type="button"
          className="w-full py-0.5 text-left text-muted-foreground hover:bg-accent hover:text-foreground"
          style={indent(depth)}
          disabled={loadingMore}
          onClick={() => void showMore()}
        >
          {translate('debug.variables.showMore', 'Show more')}
        </button>
      ) : null}
    </ul>
  )
}

function DebugVariableRow({
  context,
  variable,
  parentReference,
  path,
  depth,
  onUpdated
}: {
  context: DebugVariableTreeContext
  variable: DebugVariableWire
  parentReference: number
  path: string
  depth: number
  onUpdated: (variable: DebugVariableWire) => void
}): React.JSX.Element {
  const { client, target, canSetVariable, expanded, onToggle } = context
  const [editing, setEditing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const expandable = variable.variablesReference > 0
  const open = expandable && expanded.has(path)

  const commit = async (value: string): Promise<void> => {
    try {
      const result = await client.setVariable({
        ...target,
        variablesReference: parentReference,
        name: variable.name,
        value
      })
      if (!result.ok) {
        setError(result.message)
        return
      }
      setEditing(null)
      setError(null)
      onUpdated({ ...variable, ...result.value, name: variable.name })
    } catch (caught) {
      setError(debugErrorMessage(caught))
    }
  }
  const startEdit = (): void => setEditing(variable.value)

  return (
    <li>
      <div className="flex items-center gap-1 py-0.5 pr-2 hover:bg-accent" style={indent(depth)}>
        {expandable ? (
          <button
            type="button"
            aria-expanded={open}
            title={variable.name}
            className="flex min-w-0 max-w-[50%] shrink-0 items-center gap-1 text-left text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            onClick={() => onToggle(path)}
          >
            <ChevronRight className={cn('size-3 shrink-0', open && 'rotate-90')} />
            <span className="min-w-0 truncate">{variable.name}</span>
          </button>
        ) : (
          <span
            title={variable.name}
            className="flex min-w-0 max-w-[50%] shrink-0 items-center gap-1 text-foreground"
          >
            <ChevronRight className="invisible size-3 shrink-0" />
            <span className="min-w-0 truncate">{variable.name}</span>
          </span>
        )}
        <span className="shrink-0 text-muted-foreground">=</span>
        {editing !== null ? (
          <ImeInput
            autoFocus
            aria-label={translate('debug.variables.editValue', 'New value')}
            aria-invalid={error !== null}
            className="min-w-0 flex-1 rounded-sm border border-ring bg-transparent px-1 font-mono text-xs text-foreground outline-none"
            value={editing}
            onChange={(event) => setEditing(event.target.value)}
            onBlur={() => {
              setEditing(null)
              setError(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                void commit(editing)
              } else if (event.key === 'Escape') {
                setEditing(null)
                setError(null)
              }
            }}
          />
        ) : canSetVariable ? (
          <button
            type="button"
            className="min-w-0 truncate text-left font-mono text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            title={variable.value}
            aria-label={translate('debug.variables.valueOf', '{{name}} value: {{value}}', {
              name: variable.name,
              value: variable.value
            })}
            aria-keyshortcuts="F2"
            data-testid="debug-variable-value"
            onDoubleClick={startEdit}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === 'F2') {
                event.preventDefault()
                startEdit()
              }
            }}
          >
            {variable.value}
          </button>
        ) : (
          <span
            className="min-w-0 truncate font-mono text-muted-foreground"
            title={variable.value}
            data-testid="debug-variable-value"
          >
            {variable.value}
          </span>
        )}
      </div>
      {error !== null ? (
        <div role="alert" className="py-0.5 text-destructive" style={indent(depth + 1)}>
          {error}
        </div>
      ) : null}
      {open ? (
        <DebugVariableChildren
          context={context}
          variablesReference={variable.variablesReference}
          total={childTotal(variable)}
          path={path}
          depth={depth + 1}
        />
      ) : null}
    </li>
  )
}
