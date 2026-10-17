import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { DebugScopeWire } from '../../../../preload/api/debug-api'
import { debugErrorMessage, type DebugSectionProps } from './debug-section-contract'
import {
  childTotal,
  DebugVariableChildren,
  type DebugVariableTreeContext
} from './DebugVariableTree'

export default function DebugVariablesSection({
  client,
  target,
  session
}: DebugSectionProps): React.JSX.Element {
  const { selectedFrameId: frameId, selectionEpoch, stopSeq } = session
  // null while the scopes request is in flight.
  const [scopes, setScopes] = useState<DebugScopeWire[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Paths stay expanded across stops, so stepping keeps the tree the user opened.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const canSetVariable = session.snapshot?.capabilities.supportsSetVariable === true

  useEffect(() => {
    let current = true
    setScopes(null)
    setError(null)
    if (frameId === null) {
      return
    }
    client
      .scopes({ ...target, frameId })
      .then((result) => {
        if (current) {
          if (result.ok) {
            setScopes(result.value)
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
    // stopSeq: a step re-stops the same thread, often on the same frame id.
  }, [client, target, frameId, selectionEpoch, stopSeq])

  const onToggle = useCallback((path: string) => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (!next.delete(path)) {
        next.add(path)
      }
      return next
    })
  }, [])

  const context = useMemo<DebugVariableTreeContext>(
    () => ({ client, target, canSetVariable, expanded, onToggle }),
    [client, target, canSetVariable, expanded, onToggle]
  )

  if (frameId === null) {
    return (
      <div className="px-3 py-1 text-muted-foreground">
        {translate('debug.variables.notPaused', 'Not paused')}
      </div>
    )
  }
  if (error !== null) {
    return (
      <div role="alert" className="px-3 py-1 text-destructive">
        {error}
      </div>
    )
  }
  if (scopes === null) {
    return (
      <div className="px-3 py-1 text-muted-foreground">
        {translate('debug.variables.loading', 'Loading…')}
      </div>
    )
  }
  return (
    <ul aria-label={translate('debug.variables.title', 'Variables')}>
      {scopes.map((scope) => {
        const path = scope.name
        const open = expanded.has(path)
        return (
          <li key={scope.name}>
            <button
              type="button"
              aria-expanded={open}
              className="flex w-full items-center gap-1 px-2 py-0.5 text-left font-medium hover:bg-accent"
              onClick={() => onToggle(path)}
            >
              <ChevronRight className={cn('size-3 shrink-0', open && 'rotate-90')} />
              <span className="truncate">{scope.name}</span>
            </button>
            {open ? (
              <DebugVariableChildren
                context={context}
                variablesReference={scope.variablesReference}
                total={childTotal(scope)}
                path={path}
                depth={1}
              />
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
