import { useCallback, useRef, useState } from 'react'
import { Loader2, MoreHorizontal, Pencil, PlugZap, Trash2 } from 'lucide-react'
import type {
  SshConnectionState,
  SshConnectionStatus,
  SshTarget
} from '../../../../shared/ssh-types'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { isSshTargetConnecting, type SshTargetBusyAction } from './ssh-target-action-state'
import { sshIdentityFileName } from './ssh-target-list-model'
import { isManagedServerSshHost } from './SshManagedHostRemoveDialog'
import {
  SshTargetServerDialogs,
  SshTargetServerMenuItems,
  SshTargetServerStatusLine,
  type SshTargetServerDialog
} from './SshTargetServerStatus'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

export const STATUS_LABELS: Record<SshConnectionStatus, string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  'auth-failed': 'Auth failed',
  'deploying-relay': 'Deploying relay…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  'reconnection-failed': 'Reconnection failed',
  get error() {
    return translate('auto.components.settings.SshTargetCard.18968ede9e', 'Error')
  }
}

export function statusColor(status: SshConnectionStatus): string {
  switch (status) {
    case 'connected':
      return 'bg-status-success'
    case 'connecting':
    case 'deploying-relay':
    case 'reconnecting':
      return 'bg-status-warning'
    case 'auth-failed':
    case 'reconnection-failed':
    case 'error':
      return 'bg-destructive'
    case 'disconnected':
      return 'bg-muted-foreground/40'
  }
}

type SshTargetCardProps = {
  target: SshTarget
  state: SshConnectionState | undefined
  testing: boolean
  busyAction?: SshTargetBusyAction
  selected?: boolean
  onSelectClick?: (targetId: string, shiftKey: boolean) => void
  onConnect: (targetId: string) => void | Promise<void>
  onDisconnect: (targetId: string) => void | Promise<void>
  onTest: (targetId: string) => void | Promise<void>
  onEdit: (target: SshTarget) => void
  onRemove: (targetId: string) => void
  onServerChanged?: () => void
}

export function SshTargetCard({
  target,
  state,
  testing,
  busyAction,
  selected = false,
  onSelectClick,
  onConnect,
  onDisconnect,
  onTest,
  onEdit,
  onRemove,
  onServerChanged
}: SshTargetCardProps): React.JSX.Element {
  const status: SshConnectionStatus = state?.status ?? 'disconnected'
  const [actionInFlight, setActionInFlight] = useState<'connect' | 'disconnect' | null>(null)
  const [serverDialog, setServerDialog] = useState<SshTargetServerDialog | null>(null)
  const hasActionInFlight = actionInFlight !== null || busyAction !== undefined
  const removeInFlight = busyAction === 'remove'
  const mountedRef = useRef(true)
  const endpoint = target.username
    ? `${target.username}@${target.host}:${target.port}`
    : `${target.host}:${target.port}`
  const keyName = sshIdentityFileName(target.identityFile)
  const servedByOrcaServer =
    isManagedServerSshHost(target) || state?.managedServer?.kind === 'managed'

  const handleCardRef = useCallback((node: HTMLDivElement | null): void => {
    // Root attachment guards async completions after card removal without a passive effect.
    mountedRef.current = node !== null
  }, [])

  const clearActionInFlight = (): void => {
    if (mountedRef.current) {
      setActionInFlight(null)
    }
  }

  const handleConnect = (): void => {
    if (actionInFlight) {
      return
    }
    setActionInFlight('connect')
    void Promise.resolve(onConnect(target.id)).finally(clearActionInFlight)
  }

  const handleDisconnect = (): void => {
    if (actionInFlight) {
      return
    }
    setActionInFlight('disconnect')
    void Promise.resolve(onDisconnect(target.id)).finally(clearActionInFlight)
  }

  const renderStatus = (): React.JSX.Element | null => {
    if (removeInFlight || testing) {
      return (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          {removeInFlight
            ? translate('auto.components.settings.SshTargetCard.removing', 'Removing…')
            : translate('auto.components.settings.SshTargetCard.testing', 'Testing…')}
        </span>
      )
    }
    // Disconnected is the resting state of every saved host, so it stays unlabeled.
    if (status === 'disconnected') {
      return null
    }
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className={cn('size-1.5 shrink-0 rounded-full', statusColor(status))} />
        {STATUS_LABELS[status]}
      </span>
    )
  }

  const renderPrimaryAction = (): React.JSX.Element => {
    if (status === 'connected') {
      return (
        <Button variant="ghost" size="xs" onClick={handleDisconnect} disabled={hasActionInFlight}>
          {translate('auto.components.settings.SshTargetCard.4c86f30877', 'Disconnect')}
        </Button>
      )
    }
    if (isSshTargetConnecting(status)) {
      return (
        <Button variant="ghost" size="xs" disabled>
          {translate('auto.components.settings.SshTargetCard.1810b51482', 'Connecting')}
        </Button>
      )
    }
    const button = (
      <Button variant="ghost" size="xs" onClick={handleConnect} disabled={hasActionInFlight}>
        {actionInFlight === 'connect' ? <Loader2 className="size-3 animate-spin" /> : null}
        {translate('auto.components.settings.SshTargetCard.ec6543cee9', 'Connect')}
      </Button>
    )
    if (status !== 'disconnected' || actionInFlight === 'connect') {
      return button
    }
    // Reveal repetitive Connect labels on hover/focus while retaining width to avoid shifts.
    return (
      <span className="opacity-0 transition-opacity group-hover/row:opacity-100 group-has-[:focus-visible]/row:opacity-100">
        {button}
      </span>
    )
  }

  return (
    <div
      ref={handleCardRef}
      data-ssh-target-card=""
      data-ssh-target-label={target.label}
      data-selected={selected ? 'true' : undefined}
      className="group/row flex items-start gap-3 px-3 py-2 transition-colors hover:bg-accent/40 data-[selected=true]:bg-accent/60 has-[[data-slot=checkbox]:focus-visible]:ring-2 has-[[data-slot=checkbox]:focus-visible]:ring-ring/60 has-[[data-slot=checkbox]:focus-visible]:ring-inset"
    >
      {onSelectClick ? (
        <Checkbox
          className="mt-0.5"
          checked={selected}
          aria-label={translate(
            'auto.components.settings.SshTargetCard.select',
            'Select {{label}}',
            {
              label: target.label
            }
          )}
          onClick={(event) => {
            // Selection owns modifier-aware state; suppress Radix’s modifier-blind click toggle.
            event.preventDefault()
            onSelectClick(target.id, event.shiftKey)
          }}
        />
      ) : null}

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-medium">{target.label}</span>
          {servedByOrcaServer ? (
            <Badge variant="hostContext" className="self-center">
              {translate('auto.components.settings.SshTargetCard.orcaServer', 'Orca server')}
            </Badge>
          ) : null}
          {/* Keep the separator outside monospace spans so its width stays compact. */}
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            <span className="font-mono">{endpoint}</span>
            {keyName ? (
              <>
                {' '}
                <span className="px-0.5">·</span> <span className="font-mono">{keyName}</span>
              </>
            ) : null}
          </span>
        </div>
        {/* Wrap host-key errors so the trailing recovery command remains reachable. */}
        {/* An unserved host's status line below says why, translated; this is its English twin. */}
        {state?.error && state.managedServer?.kind !== 'relay' ? (
          <p className="mt-0.5 text-xs text-destructive [overflow-wrap:anywhere]">{state.error}</p>
        ) : null}
        <SshTargetServerStatusLine target={target} state={state} onOpenDialog={setServerDialog} />
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {renderStatus()}
        {renderPrimaryAction()}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={removeInFlight}
              aria-label={translate(
                'auto.components.settings.SshTargetCard.moreActions',
                'More actions for {{label}}',
                { label: target.label }
              )}
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuItem
              disabled={
                testing ||
                hasActionInFlight ||
                status === 'connected' ||
                isSshTargetConnecting(status)
              }
              onSelect={() => void onTest(target.id)}
            >
              <PlugZap />
              {translate(
                'auto.components.settings.SshTargetCard.testConnection',
                'Test connection'
              )}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={hasActionInFlight} onSelect={() => onEdit(target)}>
              <Pencil />
              {translate('auto.components.settings.SshTargetCard.edit', 'Edit…')}
            </DropdownMenuItem>
            <SshTargetServerMenuItems
              target={target}
              state={state}
              onOpenDialog={setServerDialog}
            />
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={hasActionInFlight}
              onSelect={() => onRemove(target.id)}
            >
              <Trash2 />
              {translate('auto.components.settings.SshTargetCard.remove', 'Remove…')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <SshTargetServerDialogs
        target={target}
        state={state}
        dialog={serverDialog}
        onDialogChange={setServerDialog}
        onChanged={() => onServerChanged?.()}
      />
    </div>
  )
}
