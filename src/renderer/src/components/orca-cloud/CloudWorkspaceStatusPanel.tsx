// The cloud workspace card (sidebar hover/pinned popover), calm by default (Neil, 5db0b968935f):
// name and state, one usage line, at most one attention row, "On this computer ›", and one footer
// action beside ⋯. Details and the sync settings are one step away, never on the first view.
import React, { useEffect, useId, useState } from 'react'
import {
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Loader2,
  Moon,
  Play,
  RotateCw,
  ArchiveRestore
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { Skeleton } from '@/components/ui/skeleton'
import { cloudWorkspaceMoved } from '@/lib/orca-cloud/orca-cloud-move-store'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import { useNow } from '@/hooks/use-now'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/github/refresh/worktree-refresh'
import {
  formatShortDate,
  isWakeActive,
  type CloudDotState
} from '@/lib/orca-cloud/orca-cloud-workspace-state'
import {
  refreshCloudWorkspaceStatus,
  useCloudWorkspace,
  type CloudStatusEntry
} from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { useCloudSync } from '@/lib/orca-cloud/cloud-sync-store'
import type { CloudSyncView } from '../../../../shared/cloud-sync/cloud-sync-contract'
import { CloudStatusGlyph } from './CloudStatusGlyph'
import { cloudStateLabel } from './cloud-state-copy'
import { CloudWorkspaceSyncSection } from './CloudWorkspaceSyncSection'
import { CloudWorkspaceCardDetails, MeterSkeleton } from './CloudWorkspaceCardDetails'
import { CloudWorkspaceCardMenu } from './CloudWorkspaceCardMenu'
import { useCloudOfflineData } from './offline/use-cloud-offline-data'
import {
  cloudCardAttentionLabel,
  cloudCardOnComputerStatus,
  cloudCardPrimary,
  cloudCardStateDetail,
  cloudCardUsageLine,
  type CloudCardAttention
} from './cloud-workspace-card-model'
import {
  openCloudCardAttention,
  setCloudCardDetailsOpen,
  useCloudCardAttention,
  useCloudCardDetailsOpen
} from './use-cloud-workspace-card-state'

export type CloudPanelActions = {
  onWake: () => void
  onRestart: () => void
  onArchive: () => void
  onUnarchive: () => void
  /** Put a running sandbox to sleep (frees one of the team's running slots). */
  onSleep?: () => void
  /** "Move to this computer"; absent where the move isn't offered (fixtures, older bridges). */
  onMoveToComputer?: () => void
  /** Delete the workspace (the sidebar's own delete flow and confirmation). */
  onDelete?: () => void
}

type Pending = 'restart' | 'archive' | 'unarchive' | undefined

/** Pending buttons stay focused and announced: aria-disabled + aria-busy, never `disabled`. */
function busyProps(isBusy: boolean, anyBusy: boolean, onClick: () => void) {
  return {
    'aria-disabled': anyBusy || undefined,
    'aria-busy': isBusy || undefined,
    onClick: () => {
      if (!anyBusy) {
        onClick()
      }
    }
  }
}

const ROW =
  'flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 -mx-1.5 text-start hover:bg-muted/50 focus-visible:outline-[var(--focus-ring)]'

export type CloudCardLayer = 'main' | 'onComputer'

export function CloudWorkspaceStatusPanel({
  workspaceId,
  state: rawState,
  entry,
  pending,
  actions,
  className,
  name: nameOverride,
  attention: attentionOverride,
  asOf: asOfOverride,
  initialLayer = 'main',
  detailsOpen: detailsOverride,
  escapeRef,
  onMenuOpenChange
}: {
  workspaceId: string
  state: CloudDotState
  entry: CloudStatusEntry | undefined
  pending: Pending
  actions: CloudPanelActions
  className?: string
  /** Fixtures: the workspace name and attention row without the app's stores. */
  name?: string
  attention?: CloudCardAttention | null
  asOf?: number | null
  initialLayer?: CloudCardLayer
  /** Fixtures: Details open without touching the app session's choice. */
  detailsOpen?: boolean
  /** The popover's Escape asks this first: true when the card closed an inner layer instead. */
  escapeRef?: React.MutableRefObject<(() => boolean) | null>
  onMenuOpenChange?: (open: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const now = useNow(5_000)
  const headingId = useId()
  const detailsId = useId()
  const [layer, setLayer] = useState<CloudCardLayer>(initialLayer)
  const sessionDetailsOpen = useCloudCardDetailsOpen()
  const detailsOpen = detailsOverride ?? sessionDetailsOpen
  const storeName = useAppStore((s) => findWorktreeById(s, workspaceId)?.displayName ?? null)
  const liveAttention = useCloudCardAttention(workspaceId)
  const sync = useCloudSync(workspaceId)
  // A restart in flight is a wake, whatever the last status read said: one this card started, or a
  // session rollover main is running (24h cap or "Restart now" from the toast).
  const rollover = useCloudWorkspace((s) => s.wake[workspaceId])
  const restarting =
    pending === 'restart' || (rollover?.source === 'restart' && isWakeActive(rollover, now))
  const state: CloudDotState = restarting ? 'waking' : rawState
  const offline = useCloudOfflineData(
    workspaceId,
    state === 'sleeping' && asOfOverride === undefined
  )
  const status = entry?.status ?? null
  const metrics = status?.metrics ?? null
  const moved = cloudWorkspaceMoved(workspaceId)
  const unavailable = !status && Boolean(entry?.error)
  const firstLoad = !status && !entry?.error
  const anyBusy = pending !== undefined
  const live = state === 'running' || state === 'unresponsive'
  const canArchive = state === 'running' || state === 'sleeping' || state === 'unresponsive'
  const canRestart = live || state === 'failed' || state === 'wakeFailed'
  const attention = attentionOverride === undefined ? liveAttention : attentionOverride
  const name = nameOverride ?? storeName
  const asOf = asOfOverride === undefined ? (offline.snapshot?.capturedAt ?? null) : asOfOverride
  const detail = unavailable
    ? null
    : cloudCardStateDetail(
        {
          state,
          restarting,
          idleSleepMinutes: status?.idleSleepMinutes,
          asOf,
          keptUntil: status?.archive?.expiresAt
        },
        t
      )
  const primary = cloudCardPrimary(rawState, restarting)
  // The timer and the "As of" time fit beside the state; other states' sentences get their own line.
  const shortDetail = !restarting && (state === 'running' || state === 'sleeping')

  useEffect(() => {
    if (!escapeRef) {
      return
    }
    escapeRef.current = () => {
      if (layer === 'main') {
        return false
      }
      setLayer('main')
      return true
    }
    return () => {
      escapeRef.current = null
    }
  }, [escapeRef, layer])

  if (layer === 'onComputer') {
    return (
      <div
        className={cn('flex flex-col gap-3 text-xs', className)}
        data-cloud-status-panel={workspaceId}
      >
        <button
          type="button"
          className={cn(ROW, 'font-medium text-foreground')}
          onClick={() => setLayer('main')}
          autoFocus
        >
          <ChevronLeft aria-hidden className="size-3.5 text-muted-foreground" />
          <span id={headingId}>{t('orcaCloudSync.title', 'On this computer')}</span>
        </button>
        <CloudWorkspaceSyncSection workspaceId={workspaceId} labelledBy={headingId} />
      </div>
    )
  }

  return (
    <div
      className={cn('flex flex-col gap-2.5 text-xs', className)}
      data-cloud-status-panel={workspaceId}
    >
      <div className="min-w-0">
        {name ? (
          <div className="truncate text-[13px] font-medium text-foreground">{name}</div>
        ) : null}
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-muted-foreground">
          <CloudStatusGlyph
            state={unavailable ? 'unknown' : restarting ? 'restarting' : state}
            size={14}
          />
          <span className="min-w-0 truncate">
            <span className="text-foreground">
              {unavailable ? (
                t('orcaCloudWorkspace.statusUnavailable', 'Status unavailable')
              ) : restarting ? (
                t('orcaCloudWorkspace.state.restarting', 'Restarting')
              ) : state === 'unknown' ? (
                // Not yet read: a placeholder, not a word that reads like a state.
                <>
                  <Skeleton
                    shape="small"
                    className="inline-block h-3 w-14 align-middle"
                    aria-hidden="true"
                  />
                  <span className="sr-only">{cloudStateLabel(state, t)}</span>
                </>
              ) : (
                cloudStateLabel(state, t)
              )}
            </span>
            {detail && shortDetail ? <> · {detail}</> : null}
          </span>
        </div>
        {/* Longer state lines (archived, not responding, couldn't start) wrap below, never cut off. */}
        {detail && !shortDetail ? <p className="mt-1 text-muted-foreground">{detail}</p> : null}
      </div>

      {unavailable ? (
        <InlineError
          tone="neutral"
          title={t('orcaCloudWorkspace.statusUnavailableTitle', 'Couldn’t get the sandbox status.')}
          retryLabel={t('orcaCloudWorkspace.tryAgain', 'Try again')}
          retrying={entry?.loading}
          onRetry={() => void refreshCloudWorkspaceStatus(workspaceId)}
          density="compact"
        />
      ) : firstLoad ? (
        <div
          role="status"
          aria-busy="true"
          aria-label={t('orcaCloudWorkspace.loading', 'Loading status')}
        >
          <Skeleton shape="small" className="h-3 w-40" aria-hidden="true" />
        </div>
      ) : null}

      {status && live && metrics && !restarting ? (
        <button
          type="button"
          className={cn(ROW, 'text-muted-foreground')}
          aria-expanded={detailsOpen}
          aria-controls={detailsId}
          onClick={() => setCloudCardDetailsOpen(!detailsOpen)}
          data-cloud-card-usage
        >
          <span className="min-w-0 flex-1 truncate tabular-nums">
            {cloudCardUsageLine(metrics, t)}
          </span>
          {/* Expands in place (⌄ / ⌃); › is kept for rows that open another view. */}
          {detailsOpen ? (
            <ChevronUp aria-hidden className="size-3.5 shrink-0" />
          ) : (
            <ChevronDown aria-hidden className="size-3.5 shrink-0" />
          )}
          <span className="sr-only">{t('orcaCloudWorkspace.card.details', 'Details')}</span>
        </button>
      ) : null}
      {status && detailsOpen ? (
        <CloudWorkspaceCardDetails
          id={detailsId}
          status={status}
          showMeters={live}
          restarting={restarting}
        />
      ) : firstLoad && detailsOpen ? (
        <MeterSkeleton />
      ) : null}

      {attention ? (
        <button
          type="button"
          className={cn(ROW, 'font-medium text-status-warning-text')}
          onClick={() => openCloudCardAttention(workspaceId, attention)}
          data-cloud-card-attention={attention.kind}
        >
          <span className="size-1.5 shrink-0 rounded-full bg-status-warning" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{cloudCardAttentionLabel(attention, t)}</span>
          <ChevronRight aria-hidden className="size-3.5 shrink-0" />
        </button>
      ) : null}

      {moved ? (
        <p className="text-muted-foreground">
          {t('orcaCloudWorkspace.copiedOn', 'Moved to this computer · {{date}}', {
            date: formatShortDate(moved.at)
          })}
          {moved.localWorktreeId ? (
            <>
              {' · '}
              <button
                type="button"
                className="text-foreground underline-offset-2 hover:underline focus-visible:outline-[var(--focus-ring)]"
                onClick={() => activateAndRevealWorktree(moved.localWorktreeId!)}
              >
                {t('orcaCloudWorkspace.openLocal', 'Open local workspace')}
              </button>
            </>
          ) : null}
        </p>
      ) : null}

      {state === 'archived' ? null : (
        <OnComputerRow view={sync} onOpen={() => setLayer('onComputer')} />
      )}

      <div className="flex min-h-6 items-center justify-end gap-1 border-t border-border/60 pt-2">
        <PrimaryAction
          primary={primary}
          pending={pending}
          restarting={restarting}
          anyBusy={anyBusy}
          actions={actions}
        />
        <CloudWorkspaceCardMenu
          disabled={anyBusy || restarting}
          onOpenChange={onMenuOpenChange}
          items={{
            details: { open: detailsOpen, toggle: () => setCloudCardDetailsOpen(!detailsOpen) },
            restart: canRestart && primary !== 'restart' ? actions.onRestart : undefined,
            moveToComputer: canArchive ? actions.onMoveToComputer : undefined,
            archive: canArchive ? actions.onArchive : undefined,
            delete: actions.onDelete
          }}
        />
      </div>
    </div>
  )
}

function OnComputerRow({
  view,
  onOpen
}: {
  view: CloudSyncView | null
  onOpen: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <button type="button" className={ROW} onClick={onOpen} data-cloud-card-on-computer>
      <span className="text-foreground">{t('orcaCloudSync.title', 'On this computer')}</span>
      <span className="min-w-0 flex-1 truncate text-end text-muted-foreground">
        {cloudCardOnComputerStatus(view, t)}
      </span>
      <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
  )
}

function PrimaryAction({
  primary,
  pending,
  restarting,
  anyBusy,
  actions
}: {
  primary: ReturnType<typeof cloudCardPrimary>
  pending: Pending
  restarting: boolean
  anyBusy: boolean
  actions: CloudPanelActions
}): React.JSX.Element | null {
  const t = useTranslate()
  switch (primary) {
    case 'sleep':
      return actions.onSleep ? (
        <Button size="xs" variant="outline" {...busyProps(false, anyBusy, actions.onSleep)}>
          <Moon />
          {t('orcaCloudWorkspace.sleep', 'Sleep')}
        </Button>
      ) : null
    case 'wake':
      return (
        <Button size="xs" {...busyProps(false, anyBusy, actions.onWake)}>
          <Play />
          {t('orcaCloudWorkspace.wake', 'Wake')}
        </Button>
      )
    case 'unarchive':
      return (
        <Button size="xs" {...busyProps(pending === 'unarchive', anyBusy, actions.onUnarchive)}>
          {pending === 'unarchive' ? <Loader2 className="animate-spin" /> : <ArchiveRestore />}
          {t('orcaCloudWorkspace.unarchive', 'Unarchive')}
        </Button>
      )
    case 'restart':
      return (
        <Button size="xs" {...busyProps(restarting, anyBusy, actions.onRestart)}>
          {restarting ? <Loader2 className="animate-spin" /> : <RotateCw />}
          {restarting
            ? t('orcaCloudWorkspace.restarting', 'Restarting…')
            : t('orcaCloudWorkspace.restart', 'Restart')}
        </Button>
      )
    case null:
      return null
  }
}
