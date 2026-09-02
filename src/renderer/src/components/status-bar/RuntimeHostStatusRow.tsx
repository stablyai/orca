import { useCallback, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTimeFromDate } from '@/i18n/relative-time-format'
import { useMountedRef } from '@/hooks/useMountedRef'
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import {
  isConnectedRuntimeHostState,
  type RuntimeHostConnectionState
} from '@/runtime/runtime-host-connection-state'
import type { RemoteRuntimeSharedConnectionDiagnostics } from '../../../../shared/remote-runtime-shared-control-types'

function runtimeStatusLabel(state: RuntimeHostConnectionState): string {
  switch (state) {
    case 'connected':
      return translate('auto.components.status.bar.SshStatusSegment.runtime_online', 'Connected')
    case 'runtime-unavailable':
      return translate(
        'auto.components.status.bar.SshStatusSegment.runtime_unavailable_transport_up',
        'Orca unavailable'
      )
    case 'workspace-window-closed':
      return translate(
        'auto.components.status.bar.SshStatusSegment.runtime_workspace_window_closed',
        'Workspace window closed'
      )
    case 'checking':
      return translate('auto.components.status.bar.SshStatusSegment.runtime_checking', 'Checking')
    case 'reconnecting':
      return translate(
        'auto.components.status.bar.SshStatusSegment.runtime_reconnecting',
        'Reconnecting'
      )
    case 'disconnected':
      return translate(
        'auto.components.status.bar.SshStatusSegment.runtime_unavailable',
        'Disconnected'
      )
  }
}

function runtimeDotColor(state: RuntimeHostConnectionState): string {
  switch (state) {
    case 'connected':
      return 'bg-emerald-500'
    case 'workspace-window-closed':
    case 'checking':
    case 'reconnecting':
    case 'runtime-unavailable':
      return 'bg-yellow-500'
    case 'disconnected':
      return 'bg-muted-foreground/40'
  }
}

function runtimeStatusTone(state: RuntimeHostConnectionState): string {
  if (
    state === 'checking' ||
    state === 'reconnecting' ||
    state === 'workspace-window-closed' ||
    state === 'runtime-unavailable'
  ) {
    return 'text-yellow-500'
  }
  return 'text-muted-foreground'
}

function runtimeActionLabel(state: RuntimeHostConnectionState): string | null {
  switch (state) {
    case 'connected':
    case 'workspace-window-closed':
    case 'runtime-unavailable':
      return translate('auto.components.status.bar.SshStatusSegment.59b553e2aa', 'Disconnect')
    case 'disconnected':
      return translate('auto.components.status.bar.SshStatusSegment.63f36455cc', 'Connect')
    case 'checking':
    case 'reconnecting':
      return null
  }
}

function runtimeFailureSummary(state: RuntimeHostConnectionState): string {
  switch (state) {
    case 'connected':
      return translate(
        'auto.components.status.bar.RuntimeHostStatusRow.previous_connection_closed',
        'The previous connection closed'
      )
    case 'workspace-window-closed':
      return translate(
        'auto.components.status.bar.RuntimeHostStatusRow.workspace_window_closed',
        'The workspace window is closed'
      )
    case 'runtime-unavailable':
      return translate(
        'auto.components.status.bar.RuntimeHostStatusRow.runtime_unavailable',
        'SSH transport is connected, but the Orca runtime is unavailable'
      )
    case 'checking':
      return translate(
        'auto.components.status.bar.RuntimeHostStatusRow.checking_host',
        'Orca is checking whether this host is reachable'
      )
    case 'reconnecting':
      return translate(
        'auto.components.status.bar.RuntimeHostStatusRow.restoring_connection',
        'Orca is trying to restore the connection'
      )
    case 'disconnected':
      return translate(
        'auto.components.status.bar.RuntimeHostStatusRow.host_unreachable',
        'Orca isn’t reachable on this host'
      )
  }
}

function runtimeFailureExplanation(state: RuntimeHostConnectionState): string | null {
  if (state === 'connected' || state === 'workspace-window-closed') {
    return null
  }
  if (state === 'runtime-unavailable') {
    return translate(
      'auto.components.status.bar.RuntimeHostStatusRow.runtime_unavailable_explanation',
      'The remote host may still be running; only the Orca runtime connection is unavailable.'
    )
  }
  return translate(
    'auto.components.status.bar.RuntimeHostStatusRow.contact_note',
    'The host may still be running; only the Orca connection is unavailable.'
  )
}

export function RuntimeHostStatusRow({
  label,
  state,
  detail,
  diagnostics,
  onConnect,
  onDisconnect
}: {
  label: string
  state: RuntimeHostConnectionState
  detail?: string
  diagnostics?: RemoteRuntimeSharedConnectionDiagnostics | null
  onConnect?: () => Promise<void>
  onDisconnect?: () => Promise<void>
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [submenuOpen, setSubmenuOpen] = useState(false)
  const actionPointerActiveRef = useRef(false)
  const mountedRef = useMountedRef()
  const actionLabel = runtimeActionLabel(state)

  const handleAction = useCallback(async () => {
    const action = isConnectedRuntimeHostState(state) ? onDisconnect : onConnect
    if (!action) {
      return
    }
    setBusy(true)
    try {
      await action()
    } finally {
      if (mountedRef.current) {
        setBusy(false)
      }
    }
  }, [mountedRef, onConnect, onDisconnect, state])

  const action = isConnectedRuntimeHostState(state) ? onDisconnect : onConnect
  const lastConnectedLabel = diagnostics?.lastConnectedAt
    ? translate(
        'auto.components.status.bar.RuntimeHostStatusRow.last_connected',
        'Last connected {{value0}}',
        {
          value0: formatUiRelativeTimeFromDate(new Date(diagnostics.lastConnectedAt).toISOString())
        }
      )
    : null
  const reconnectAttemptLabel =
    diagnostics && state === 'reconnecting'
      ? translate(
          'auto.components.status.bar.RuntimeHostStatusRow.reconnect_attempt',
          'Attempt {{value0}}',
          { value0: String(diagnostics.reconnectAttempt + 1) }
        )
      : null
  const diagnosticLabel = [lastConnectedLabel, reconnectAttemptLabel].filter(Boolean).join(' · ')
  const rawDetail = diagnostics?.lastError ?? diagnostics?.lastClose?.reason ?? detail
  const failureExplanation = runtimeFailureExplanation(state)

  const rowDetails = (
    <>
      <span
        aria-hidden="true"
        className={`size-1.5 shrink-0 rounded-full ${runtimeDotColor(state)}`}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-medium">{label}</div>
        <div className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
          <span>
            {translate(
              'auto.components.status.bar.SshStatusSegment.remote_server',
              'Remote Server'
            )}
          </span>
          <span aria-hidden="true">·</span>
          <span className={`inline-flex min-w-0 items-center gap-1 ${runtimeStatusTone(state)}`}>
            {state === 'checking' || state === 'reconnecting' ? (
              <Loader2 className="size-2.5 shrink-0 animate-spin" />
            ) : null}
            <span className="truncate">{runtimeStatusLabel(state)}</span>
          </span>
        </div>
      </div>
    </>
  )

  const actionButton = busy ? (
    <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
  ) : actionLabel && action ? (
    detail ? (
      <span
        aria-hidden="true"
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
          void handleAction()
        }}
        className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent/70 hover:text-foreground"
      >
        {actionLabel}
      </span>
    ) : (
      <button
        type="button"
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
          void handleAction()
        }}
        className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent/70 hover:text-foreground"
      >
        {actionLabel}
      </button>
    )
  ) : null

  if (!detail) {
    return (
      <div className="flex items-center gap-2.5 px-2 py-1.5">
        {rowDetails}
        {actionButton}
      </div>
    )
  }

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
      <DropdownMenuSubContent className="w-[min(18rem,calc(100vw-1rem))] p-1.5">
        <div className="px-1.5 pt-0.5 pb-1.5">
          <div className="text-[11px] font-semibold">{runtimeFailureSummary(state)}</div>
          {failureExplanation ? (
            <div className="mt-1 text-[11px] leading-4 text-muted-foreground">
              {failureExplanation}
            </div>
          ) : null}
        </div>
        {rawDetail ? (
          <div className="mx-1 mb-1.5 max-h-24 overflow-y-auto scrollbar-sleek whitespace-pre-wrap break-words rounded-md bg-muted px-2 py-1.5 font-mono text-[10px] leading-4 text-muted-foreground [overflow-wrap:anywhere]">
            {rawDetail}
          </div>
        ) : null}
        {diagnosticLabel ? (
          <div className="px-1.5 pb-1.5 text-[10px] text-muted-foreground">{diagnosticLabel}</div>
        ) : null}
        {actionLabel && action ? (
          <DropdownMenuItem
            disabled={busy}
            onSelect={(event) => {
              event.preventDefault()
              void handleAction()
            }}
          >
            {busy ? <Loader2 className="size-3 animate-spin" /> : null}
            {actionLabel}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
