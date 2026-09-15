import { useRef, useState, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTimeFromDate } from '@/i18n/relative-time-format'
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import type { RemoteWorkspaceSyncStatus } from '../../store/slices/ssh'

function relativeSyncTimeLabel(
  timestamp: number,
  phase: RemoteWorkspaceSyncStatus['phase']
): string | null {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  return translate(
    phase === 'synced'
      ? 'auto.components.status.bar.SshTargetStatusRow.lastSynced'
      : 'auto.components.status.bar.SshTargetStatusRow.lastSyncAttempt',
    phase === 'synced' ? 'Last synced {{value0}}' : 'Last sync attempt {{value0}}',
    { value0: formatUiRelativeTimeFromDate(date.toISOString()) }
  )
}

export function syncStatusLabel(status: RemoteWorkspaceSyncStatus | undefined): string | null {
  switch (status?.phase) {
    case 'pulling':
      return translate(
        'auto.components.status.bar.SshTargetStatusRow.workspacePulling',
        'Workspace syncing'
      )
    case 'pushing':
      return translate(
        'auto.components.status.bar.SshTargetStatusRow.workspacePushing',
        'Workspace uploading'
      )
    case 'conflict':
      return translate(
        'auto.components.status.bar.SshTargetStatusRow.workspaceConflict',
        'Workspace layout conflict'
      )
    case 'error':
      return translate(
        'auto.components.status.bar.SshTargetStatusRow.workspaceError',
        'Workspace layout unavailable'
      )
    case 'offline':
      return translate(
        'auto.components.status.bar.SshTargetStatusRow.workspaceOffline',
        'Workspace layout unavailable'
      )
    case 'synced':
      return status.message ||
        status.direction ||
        status.revision !== undefined ||
        status.updatedAt !== undefined ||
        status.lastSyncedAt !== undefined
        ? translate(
            'auto.components.status.bar.SshTargetStatusRow.workspaceSynced',
            'Workspace synced'
          )
        : null
    case 'idle':
      return status.message
        ? translate(
            'auto.components.status.bar.SshTargetStatusRow.workspaceReady',
            'Workspace ready'
          )
        : null
    case undefined:
      return null
  }
}

export function syncStatusTone(status: RemoteWorkspaceSyncStatus | undefined): string {
  switch (status?.phase) {
    case 'conflict':
    case 'error':
      return 'text-destructive'
    case 'offline':
      return 'text-muted-foreground'
    case 'pulling':
    case 'pushing':
      return 'text-yellow-500'
    case 'synced':
      return 'text-emerald-500'
    case 'idle':
    case undefined:
      return 'text-muted-foreground'
  }
}

export function hasSyncDetails(
  status: RemoteWorkspaceSyncStatus | undefined
): status is RemoteWorkspaceSyncStatus {
  if (!status) {
    return false
  }
  if (status.phase === 'idle' || status.phase === 'synced') {
    return Boolean(
      status.message ||
      status.direction !== undefined ||
      status.revision !== undefined ||
      status.updatedAt !== undefined ||
      status.lastSyncedAt !== undefined
    )
  }
  return true
}

function syncStatusSummary(status: RemoteWorkspaceSyncStatus): string {
  switch (status.phase) {
    case 'pulling':
      return translate(
        'auto.components.status.bar.SshTargetStatusRow.syncPullingSummary',
        'Orca is copying the workspace layout from this SSH host.'
      )
    case 'pushing':
      return translate(
        'auto.components.status.bar.SshTargetStatusRow.syncPushingSummary',
        'Orca is sending the workspace layout to this SSH host.'
      )
    case 'conflict':
      return status.direction === 'pull'
        ? translate(
            'auto.components.status.bar.SshTargetStatusRow.syncConflictPullSummary',
            'The workspace layout could not be applied on this client, so sync is paused until it can be reconciled.'
          )
        : translate(
            'auto.components.status.bar.SshTargetStatusRow.syncConflictSummary',
            'The workspace layout changed on another device, so this push used an older revision and lost the race.'
          )
    case 'error':
      return translate(
        'auto.components.status.bar.SshTargetStatusRow.syncErrorSummary',
        'Orca could not sync the workspace layout to this SSH host.'
      )
    case 'offline':
      return translate(
        'auto.components.status.bar.SshTargetStatusRow.syncOfflineSummary',
        'The SSH host is unavailable for workspace layout sync.'
      )
    case 'synced':
      return translate(
        'auto.components.status.bar.SshTargetStatusRow.syncSyncedSummary',
        'The workspace layout is up to date on this SSH host.'
      )
    case 'idle':
      return translate(
        'auto.components.status.bar.SshTargetStatusRow.syncIdleSummary',
        'This SSH host has no remote workspace layout yet.'
      )
  }
}

export function SshTargetWorkspaceSyncSubmenu({
  syncStatus,
  rowDetails,
  action,
  actionLabel,
  busy,
  connectInFlight
}: {
  syncStatus: RemoteWorkspaceSyncStatus
  rowDetails: ReactNode
  action: (() => Promise<void>) | null
  actionLabel: string | null
  busy: boolean
  connectInFlight: boolean
}): React.JSX.Element {
  const [submenuOpen, setSubmenuOpen] = useState(false)
  const actionPointerActiveRef = useRef(false)
  const syncExplanation = translate(
    'auto.components.status.bar.SshTargetStatusRow.syncExplanation',
    'Workspace sync mirrors worktrees, folder workspaces, project groups, and which host each restored session uses. It does not copy your files or Git state.'
  )
  const lastSyncedLabel =
    typeof syncStatus.lastSyncedAt === 'number' && Number.isFinite(syncStatus.lastSyncedAt)
      ? relativeSyncTimeLabel(syncStatus.lastSyncedAt, syncStatus.phase)
      : null
  const directionLabel = syncStatus.direction
    ? translate(
        'auto.components.status.bar.SshTargetStatusRow.direction',
        'Direction: {{value0}}',
        {
          value0:
            syncStatus.direction === 'pull'
              ? translate('auto.components.status.bar.SshTargetStatusRow.directionPull', 'Pull')
              : translate('auto.components.status.bar.SshTargetStatusRow.directionPush', 'Push')
        }
      )
    : null
  const revisionLabel =
    typeof syncStatus.revision === 'number' && Number.isFinite(syncStatus.revision)
      ? translate('auto.components.status.bar.SshTargetStatusRow.revision', 'Revision {{value0}}', {
          value0: String(syncStatus.revision)
        })
      : null
  const syncFacts = [lastSyncedLabel, directionLabel, revisionLabel].filter(
    (value): value is string => Boolean(value)
  )
  const actionButton =
    busy || connectInFlight ? (
      <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
    ) : action && actionLabel ? (
      <span
        role="button"
        tabIndex={0}
        aria-label={actionLabel}
        onPointerEnter={() => {
          actionPointerActiveRef.current = true
          setSubmenuOpen(false)
        }}
        onPointerLeave={() => {
          actionPointerActiveRef.current = false
        }}
        onPointerMove={(event) => event.stopPropagation()}
        onPointerDown={(event) => {
          event.stopPropagation()
        }}
        onClick={(event) => {
          event.stopPropagation()
          void action()
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') {
            return
          }
          event.preventDefault()
          event.stopPropagation()
          void action()
        }}
        className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-[10px] text-muted-foreground outline-hidden hover:bg-accent/70 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
      >
        {actionLabel}
      </span>
    ) : null

  return (
    <DropdownMenuSub
      open={submenuOpen}
      onOpenChange={(open) => {
        if (!open || !actionPointerActiveRef.current) {
          setSubmenuOpen(open)
        }
      }}
    >
      <DropdownMenuSubTrigger className="gap-2.5 px-2 py-1.5" hideChevron>
        {rowDetails}
        {actionButton}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-[min(20rem,calc(100vw-1rem))] p-1.5">
        <div className="px-1.5 pt-0.5 pb-1.5">
          <div className="break-words text-[11px] font-semibold [overflow-wrap:anywhere]">
            {syncStatusSummary(syncStatus)}
          </div>
          <div className="mt-1 break-words text-[11px] leading-4 text-muted-foreground [overflow-wrap:anywhere]">
            {syncExplanation}
          </div>
        </div>
        {syncStatus.message ? (
          <div className="mx-1 mb-1.5 max-h-40 overflow-y-auto scrollbar-sleek whitespace-pre-wrap break-words rounded-md bg-muted px-2 py-1.5 text-[10px] leading-4 text-muted-foreground [overflow-wrap:anywhere]">
            {syncStatus.message}
          </div>
        ) : null}
        {syncFacts.length > 0 ? (
          <div className="space-y-0.5 px-1.5 pb-1.5 text-[10px] text-muted-foreground">
            {syncFacts.map((fact) => (
              <div key={fact} className="break-words [overflow-wrap:anywhere]">
                {fact}
              </div>
            ))}
          </div>
        ) : null}
        {action && actionLabel ? (
          <DropdownMenuItem
            disabled={busy || connectInFlight}
            onSelect={(event) => {
              event.preventDefault()
              void action()
            }}
          >
            {busy || connectInFlight ? <Loader2 className="size-3 animate-spin" /> : null}
            {actionLabel}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
