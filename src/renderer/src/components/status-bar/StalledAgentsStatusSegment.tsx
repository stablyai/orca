import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, PlugZap } from 'lucide-react'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent, formatAgentTypeLabel } from '@/lib/agent-status'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { recoverStalledAgentPanes } from '@/lib/recover-stalled-agent-panes'
import { isAutomaticAgentStallRecoveryEnabled } from '@/lib/stalled-agent-recovery-scheduler'
import { formatResetCountdown } from '../../../../shared/rate-limit-reset-format'
import type { AgentStallCause } from '../../../../shared/agent-stall-signature'
import {
  selectStalledAgentRows,
  stalledAgentRowsCanContinue,
  stalledAgentRowsPending,
  type StalledAgentRow
} from './stalled-agent-rows'

/** Long enough to cross the gap between trigger and panel without the panel
 *  vanishing mid-reach. */
const HOVER_CLOSE_DELAY_MS = 220

function causeLabel(cause: AgentStallCause): string {
  if (cause === 'auth') {
    return translate('auto.components.status.bar.StalledAgentsStatusSegment.causeAuth', 'Sign-in')
  }
  if (cause === 'rate-limit') {
    return translate(
      'auto.components.status.bar.StalledAgentsStatusSegment.causeRateLimit',
      'Usage limit'
    )
  }
  return translate('auto.components.status.bar.StalledAgentsStatusSegment.causeNetwork', 'Network')
}

function StalledAgentRowItem({
  row,
  busy,
  onContinue
}: {
  row: StalledAgentRow
  busy: boolean
  onContinue: () => void
}): React.JSX.Element {
  if (row.continuedAt !== null) {
    return (
      <div className="flex items-center gap-2 rounded-md px-1.5 py-1.5 opacity-70">
        <Check className="size-3 shrink-0 text-emerald-500" />
        <span className="min-w-0 flex-1 truncate text-[12px]">{row.worktreeName}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {translate(
            'auto.components.status.bar.StalledAgentsStatusSegment.continued',
            'Continued'
          )}
        </span>
      </div>
    )
  }

  const waitingLabel =
    row.blocked && row.resetAt !== null
      ? // Shared copy so the wording matches the usage tooltips exactly.
        formatResetCountdown(row.resetAt - Date.now())
      : row.blocked
        ? translate(
            'auto.components.status.bar.StalledAgentsStatusSegment.waitsUnknown',
            'Waiting for the window to reopen'
          )
        : null

  return (
    <div className="flex items-start gap-2 rounded-md px-1.5 py-1.5 hover:bg-accent/50">
      <span className="mt-0.5 inline-flex shrink-0">
        <AgentIcon agent={agentTypeToIconAgent(row.agentType ?? '')} size={13} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[12px] font-medium">{row.worktreeName}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {row.agentType ? formatAgentTypeLabel(row.agentType) : causeLabel(row.cause)}
          </span>
        </div>
        <span className="truncate text-[11px] text-muted-foreground" title={row.signature}>
          {waitingLabel ?? row.signature}
        </span>
      </div>
      <Button
        type="button"
        size="xs"
        variant="outline"
        className="mt-0.5 shrink-0"
        disabled={busy || row.blocked}
        onClick={onContinue}
      >
        {translate('auto.components.status.bar.StalledAgentsStatusSegment.continue', 'Continue')}
      </Button>
    </div>
  )
}

/**
 * Names the panes whose agent stopped on a login, network or usage-limit
 * failure, and lets the user continue any one of them — or all at once —
 * instead of waiting out the backoff.
 */
export function StalledAgentsStatusSegment({
  iconOnly
}: {
  iconOnly: boolean
}): React.JSX.Element | null {
  // Why the maps and not a derived count: a selector returning a fresh value on
  // every store write re-renders the whole status bar (app-store-performance).
  const stalls = useAppStore((state) => state.agentStallByPaneKey)
  const agentStatuses = useAppStore((state) => state.agentStatusByPaneKey)
  const tabsByWorktree = useAppStore((state) => state.tabsByWorktree)
  const worktreesByRepo = useAppStore((state) => state.worktreesByRepo)
  const rateLimits = useAppStore((state) => state.rateLimits)
  const ledger = useAppStore((state) => state.agentStallRecoveryLedgerByPaneKey)
  const autoRecoveryEnabled = useAppStore((state) =>
    isAutomaticAgentStallRecoveryEnabled(state.settings)
  )
  const [busyPaneKey, setBusyPaneKey] = useState<string | null>(null)
  const [recoveringAll, setRecoveringAll] = useState(false)
  const [open, setOpen] = useState(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])
  const openNow = useCallback(() => {
    cancelClose()
    setOpen(true)
  }, [cancelClose])
  const closeSoon = useCallback(() => {
    cancelClose()
    closeTimerRef.current = setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY_MS)
  }, [cancelClose])
  useEffect(() => cancelClose, [cancelClose])

  // Why a clock and not just store writes: a continued row ages out on time, and
  // a rate-limit window reopens on time, so the list has to re-derive while
  // nothing in the store changes at all.
  const [now, setNow] = useState(() => Date.now())
  const rows = useMemo(
    () =>
      selectStalledAgentRows(
        {
          agentStallByPaneKey: stalls,
          agentStatusByPaneKey: agentStatuses,
          agentStallRecoveryLedgerByPaneKey: ledger,
          tabsByWorktree,
          worktreesByRepo,
          rateLimits
        },
        now
      ),
    [stalls, agentStatuses, ledger, tabsByWorktree, worktreesByRepo, rateLimits, now]
  )
  const hasRows = rows.length > 0
  useEffect(() => {
    if (!hasRows) {
      return
    }
    const timer = setInterval(() => setNow(Date.now()), 10_000)
    return () => clearInterval(timer)
  }, [hasRows])

  if (rows.length === 0) {
    return null
  }

  const pending = stalledAgentRowsPending(rows)
  const label =
    pending.length === 0
      ? translate(
          'auto.components.status.bar.StalledAgentsStatusSegment.continuedMany',
          '{{value0}} continued',
          { value0: rows.length }
        )
      : pending.length === 1
        ? translate('auto.components.status.bar.StalledAgentsStatusSegment.one', '1 agent stalled')
        : translate(
            'auto.components.status.bar.StalledAgentsStatusSegment.many',
            '{{value0}} agents stalled',
            { value0: pending.length }
          )

  const continueOne = (paneKey: string): void => {
    if (busyPaneKey || recoveringAll) {
      return
    }
    setBusyPaneKey(paneKey)
    void recoverStalledAgentPanes({ force: true, paneKeys: [paneKey] }).finally(() => {
      setBusyPaneKey(null)
    })
  }

  const continueAll = (): void => {
    if (recoveringAll) {
      return
    }
    setRecoveringAll(true)
    void recoverStalledAgentPanes({ force: true }).finally(() => {
      setRecoveringAll(false)
    })
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-accent/70"
          aria-label={label}
          onMouseEnter={openNow}
          onMouseLeave={closeSoon}
          onFocus={openNow}
        >
          <PlugZap
            className={cn(
              'size-3',
              pending.length > 0 ? 'text-destructive' : 'text-muted-foreground'
            )}
          />
          {!iconOnly ? <span className="text-[11px] tabular-nums">{label}</span> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        sideOffset={6}
        className="w-80 p-1"
        onMouseEnter={openNow}
        onMouseLeave={closeSoon}
        // Hover-opened panels must not steal the caret from the terminal.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="flex items-center gap-2 border-b border-border px-1.5 py-1">
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            {autoRecoveryEnabled
              ? translate(
                  'auto.components.status.bar.StalledAgentsStatusSegment.autoHint',
                  'Orca is retrying these automatically.'
                )
              : translate(
                  'auto.components.status.bar.StalledAgentsStatusSegment.manualHint',
                  'Automatic retries are off.'
                )}
          </span>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={recoveringAll || Boolean(busyPaneKey) || !stalledAgentRowsCanContinue(rows)}
            onClick={continueAll}
          >
            {translate(
              'auto.components.status.bar.StalledAgentsStatusSegment.continueAll',
              'Continue all'
            )}
          </Button>
        </div>
        <div className="scrollbar-sleek max-h-72 overflow-y-auto">
          {rows.map((row) => (
            <StalledAgentRowItem
              key={row.paneKey}
              row={row}
              busy={recoveringAll || busyPaneKey === row.paneKey}
              onContinue={() => continueOne(row.paneKey)}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
