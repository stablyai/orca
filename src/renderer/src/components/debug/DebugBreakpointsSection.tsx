import { useCallback, useEffect, useState } from 'react'
import { CircleAlert, CircleCheck, CircleDashed, CircleSlash, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { DebugSessionStore } from '@/lib/debug/use-debug-session'
import type { DebugBreakpointAnswer, DebugBreakpointWire } from '../../../../preload/api/debug-api'
import {
  debugErrorMessage,
  relativeToRoot,
  type DebugRevealSource,
  type DebugSectionProps
} from './debug-section-contract'

type DebugBreakpointsSectionProps = DebugSectionProps & {
  store: DebugSessionStore
  reveal: DebugRevealSource
}

function answerLabel(state: DebugBreakpointAnswer['state']): string {
  switch (state) {
    case 'verified':
      return translate('debug.breakpoints.verified', 'Verified')
    case 'pending':
      return translate('debug.breakpoints.pending', 'Pending')
    case 'failed':
      return translate('debug.breakpoints.failed', 'Failed')
    case 'unsupported':
      return translate('debug.breakpoints.unsupported', 'Unsupported')
  }
}

const ANSWER_ICONS = {
  verified: CircleCheck,
  pending: CircleDashed,
  failed: CircleAlert,
  unsupported: CircleSlash
} as const

export default function DebugBreakpointsSection({
  client,
  target,
  session,
  store,
  reveal
}: DebugBreakpointsSectionProps): React.JSX.Element {
  const [breakpoints, setBreakpoints] = useState<DebugBreakpointWire[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const snapshotSeq = session.snapshot?.seq
  const filters = session.snapshot?.exceptionFilters ?? {
    available: [],
    enabled: []
  }

  // Breakpoint edits do not push a snapshot, so the list is re-read after each one.
  const refresh = useCallback(async () => {
    try {
      const result = await client.listBreakpoints(target)
      if (result.ok) {
        setBreakpoints(result.value)
      } else {
        setError(result.message)
      }
    } catch (caught) {
      setError(debugErrorMessage(caught))
    }
  }, [client, target])

  useEffect(() => {
    void refresh()
  }, [refresh, snapshotSeq])

  const run = async (call: () => Promise<{ ok: boolean; message?: string }>): Promise<void> => {
    try {
      const result = await call()
      setError(result.ok ? null : (result.message ?? null))
    } catch (caught) {
      setError(debugErrorMessage(caught))
    }
    await refresh()
  }

  const toggleFilter = async (filter: string, checked: boolean): Promise<void> => {
    const enabled = checked
      ? [...filters.enabled, filter]
      : filters.enabled.filter((item) => item !== filter)
    try {
      const result = await client.setExceptionFilters({
        ...target,
        filters: enabled
      })
      if (result.ok) {
        store.ingestSnapshot(result.value)
        setError(null)
      } else {
        setError(result.message)
      }
    } catch (caught) {
      setError(debugErrorMessage(caught))
    }
  }

  const groups = new Map<string, DebugBreakpointWire[]>()
  for (const breakpoint of breakpoints ?? []) {
    groups.set(breakpoint.path, [...(groups.get(breakpoint.path) ?? []), breakpoint])
  }

  return (
    <div>
      {filters.available.map((filter) => (
        <label
          key={filter.filter}
          className="flex items-center gap-2 py-0.5 pl-6 pr-2 hover:bg-accent"
        >
          <Checkbox
            checked={filters.enabled.includes(filter.filter)}
            onCheckedChange={(checked) => void toggleFilter(filter.filter, checked === true)}
          />
          <span className="truncate">{filter.label}</span>
        </label>
      ))}
      {[...groups].map(([path, items]) => (
        <div key={path} role="group" aria-label={relativeToRoot(target.worktreePath, path)}>
          <div className="truncate px-2 py-0.5 font-mono text-muted-foreground" title={path}>
            {relativeToRoot(target.worktreePath, path)}
          </div>
          {[...items]
            .sort((a, b) => a.line - b.line)
            .map((breakpoint) => {
              const Icon = ANSWER_ICONS[breakpoint.answer.state]
              const label = answerLabel(breakpoint.answer.state)
              const line = breakpoint.answer.line ?? breakpoint.line
              return (
                <div
                  key={breakpoint.id}
                  className="group flex items-center gap-2 py-0.5 pl-6 pr-1 hover:bg-accent"
                  data-testid="debug-breakpoint-row"
                >
                  <Checkbox
                    aria-label={translate('debug.breakpoints.enable', 'Enable breakpoint')}
                    checked={breakpoint.enabled}
                    onCheckedChange={(checked) =>
                      void run(() =>
                        client.updateBreakpoint({
                          ...target,
                          id: breakpoint.id,
                          fields: { enabled: checked === true }
                        })
                      )
                    }
                  />
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left font-mono"
                    onClick={() => reveal(path, line, breakpoint.column)}
                  >
                    {translate('debug.breakpoints.line', 'Line {{line}}', {
                      line
                    })}
                  </button>
                  <span
                    className={cn(
                      'flex shrink-0 items-center gap-1 text-muted-foreground',
                      breakpoint.answer.state === 'failed' && 'text-destructive'
                    )}
                    title={breakpoint.answer.message ?? label}
                  >
                    <Icon className="size-3" />
                    {label}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="shrink-0"
                    aria-label={translate('debug.breakpoints.remove', 'Remove breakpoint')}
                    onClick={() =>
                      void run(() =>
                        client.removeBreakpoint({
                          ...target,
                          id: breakpoint.id
                        })
                      )
                    }
                  >
                    <X className="size-3" />
                  </Button>
                </div>
              )
            })}
        </div>
      ))}
      {breakpoints === null && error === null ? (
        <div className="px-3 py-1 text-muted-foreground">
          {translate('debug.breakpoints.loading', 'Loading…')}
        </div>
      ) : null}
      {breakpoints?.length === 0 ? (
        <div className="px-3 py-1 text-muted-foreground">
          {translate('debug.breakpoints.empty', 'No breakpoints')}
        </div>
      ) : null}
      {error !== null ? (
        <div role="alert" className="px-3 py-1 text-destructive">
          {error}
        </div>
      ) : null}
    </div>
  )
}
