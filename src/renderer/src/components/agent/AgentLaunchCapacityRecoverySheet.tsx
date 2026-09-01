import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { getUiRelativeTimeFormatter } from '@/i18n/relative-time-format'
import { getAgentLabel } from '@/lib/agent-catalog'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { subscribeRuntimeClientEvents } from '@/runtime/runtime-client-events'
import type { PendingAgentLaunchSummaryRow } from '../../../../shared/agent-launch-pending-summary'
import {
  capacityActionCopy,
  livenessCopy,
  resolveCapacityRowAction,
  sourceKindCopy,
  type CapacityRecoveryRowAction
} from '@/lib/agent-launch-capacity-recovery-rows'

/** Localized "admitted N ago" for a row's admittedAt against a render-time now. */
function formatAdmittedAgo(admittedAt: number, now: number): string {
  // Why: the shared formatter follows the app's UI language (OS locale only when
  // the language is System), unlike a bare Intl default that always uses the OS.
  const formatter = getUiRelativeTimeFormatter()
  const seconds = Math.round((admittedAt - now) / 1000)
  const absSeconds = Math.abs(seconds)
  if (absSeconds < 60) {
    return formatter.format(Math.round(seconds), 'second')
  }
  if (absSeconds < 3600) {
    return formatter.format(Math.round(seconds / 60), 'minute')
  }
  if (absSeconds < 86400) {
    return formatter.format(Math.round(seconds / 3600), 'hour')
  }
  return formatter.format(Math.round(seconds / 86400), 'day')
}

function livenessToneClass(liveness: PendingAgentLaunchSummaryRow['liveness']): string {
  switch (liveness) {
    case 'live':
      return 'text-emerald-600 dark:text-emerald-400'
    case 'absent':
      return 'text-muted-foreground'
    case 'unknown':
      return 'text-amber-600 dark:text-amber-400'
  }
}

function CapacityRecoveryRow({
  row,
  now,
  onAction
}: {
  row: PendingAgentLaunchSummaryRow
  now: number
  onAction: (action: CapacityRecoveryRowAction) => void
}): React.JSX.Element {
  const action = resolveCapacityRowAction(row)
  const source = sourceKindCopy(row.sourceKind)
  const liveness = livenessCopy(row.liveness)
  return (
    <li className="flex items-start justify-between gap-3 rounded-md border border-border bg-card px-3 py-2.5 text-card-foreground">
      <div className="min-w-0 flex-1 text-sm leading-snug">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-medium">
          <span>{getAgentLabel(row.baseHarness)}</span>
          <span className="text-muted-foreground">{translate(source.key, source.fallback)}</span>
        </div>
        <div className="text-muted-foreground">{row.targetHostDisplayName}</div>
        <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span className={livenessToneClass(row.liveness)}>
            {translate(liveness.key, liveness.fallback)}
          </span>
          <span aria-hidden="true">·</span>
          <span>{formatAdmittedAgo(row.admittedAt, now)}</span>
        </div>
      </div>
      {action
        ? (() => {
            const label = capacityActionCopy(action, row.liveness)
            return (
              <Button type="button" size="sm" variant="outline" onClick={() => onAction(action)}>
                {translate(label.key, label.fallback)}
              </Button>
            )
          })()
        : null}
    </li>
  )
}

/** Host-owned capacity-recovery sheet (plan §1015). Lists the pending admitted
 *  launches the authenticated principal owns — source kind, base harness,
 *  target-host display name, admitted time, liveness, and a worktree deep link
 *  when one exists. Every field is host-redacted; the sheet never sees a prompt,
 *  custom id/label, argv, path, token, or env. Fetches once on open and refetches
 *  on the existing worktrees:changed event — locally from preload, and for a
 *  remote runtime target from that environment's client-event stream. No poller. */
export default function AgentLaunchCapacityRecoverySheet(): React.JSX.Element | null {
  const open = useAppStore((s) => s.activeModal === 'agent-launch-capacity-recovery')
  const target = useAppStore((s) => s.modalData.target as RuntimeClientTarget | undefined)
  const closeModal = useAppStore((s) => s.closeModal)
  const fetchSummary = useAppStore((s) => s.fetchPendingAgentLaunchSummary)
  const setPendingAutomationRunNavigation = useAppStore((s) => s.setPendingAutomationRunNavigation)
  const openAutomationsPage = useAppStore((s) => s.openAutomationsPage)
  const [rows, setRows] = useState<readonly PendingAgentLaunchSummaryRow[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const now = Date.now()

  useEffect(() => {
    if (!open) {
      setRows(null)
      setLoadFailed(false)
      return
    }
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const summary = await fetchSummary(target)
        if (!cancelled) {
          setRows(summary.rows)
          setLoadFailed(false)
        }
      } catch {
        // Client-safe by construction: the host boundary already redacts, so a
        // failure only means the query didn't complete; surface a retry-able
        // message rather than an error detail.
        if (!cancelled) {
          setLoadFailed(true)
        }
      }
    }
    void load()
    // Refetch on the host's worktree change stream (a settled/forgotten launch
    // clears its row) instead of polling; clearing the last row updates the
    // empty state from the same event.
    const unsubscribeLocal = window.api.worktrees.onChanged(() => void load())
    // Why: a remote/SSH runtime settles its launches on the host, and that never
    // reaches the local preload event — mirror the refetch off the environment's
    // own client-event stream so the sheet live-refreshes there too.
    let unsubscribeRemote: (() => void) | null = null
    if (target?.kind === 'environment') {
      void subscribeRuntimeClientEvents(target.environmentId, (event) => {
        if (event.type === 'worktreesChanged') {
          void load()
        }
      })
        .then((subscription) => {
          if (cancelled) {
            subscription.unsubscribe()
            return
          }
          unsubscribeRemote = subscription.unsubscribe
        })
        .catch(() => {
          // Live refresh is best-effort; the fetched rows still render.
        })
    }
    return () => {
      cancelled = true
      unsubscribeLocal()
      unsubscribeRemote?.()
    }
  }, [open, target, fetchSummary])

  const onAction = useCallback(
    (action: CapacityRecoveryRowAction) => {
      closeModal()
      if (action.kind === 'open-worktree') {
        activateAndRevealWorktree(action.worktreeId)
        return
      }
      // Route to the owning automation run. The deep link keys off the run's own
      // automation record (client-safe id), not the possibly-deleted per-run
      // worktree, so new_per_run automations still resolve their owner.
      setPendingAutomationRunNavigation({
        automationId: action.automationId,
        runId: action.runId
      })
      openAutomationsPage()
    },
    [closeModal, setPendingAutomationRunNavigation, openAutomationsPage]
  )

  if (!open) {
    return null
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          closeModal()
        }
      }}
    >
      <SheetContent side="right" className="gap-0">
        <SheetHeader>
          <SheetTitle>
            {translate('agentLaunch.capacity.title', 'Recover launch capacity')}
          </SheetTitle>
          <SheetDescription>
            {translate(
              'agentLaunch.capacity.description',
              'These agent launches are still pending on this host. Open a workspace to reconnect or settle it, then try launching again.'
            )}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 scrollbar-sleek overflow-y-auto px-4 pb-4">
          {loadFailed ? (
            <p className="text-sm text-muted-foreground">
              {translate(
                'agentLaunch.capacity.loadFailed',
                "Couldn't load pending launches. Close and reopen to try again."
              )}
            </p>
          ) : rows === null ? (
            <p className="text-sm text-muted-foreground">
              {translate('agentLaunch.capacity.loading', 'Loading pending launches…')}
            </p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {translate(
                'agentLaunch.capacity.empty',
                'Launch capacity is currently clear. No launches are pending on this host.'
              )}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {rows.map((row, index) => (
                <CapacityRecoveryRow
                  key={`${row.sourceKind}-${row.admittedAt}-${index}`}
                  row={row}
                  now={now}
                  onAction={onAction}
                />
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
