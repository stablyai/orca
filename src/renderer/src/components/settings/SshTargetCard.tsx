import { useState } from 'react'
import {
  CircleStop,
  Loader2,
  MonitorSmartphone,
  Pencil,
  Server,
  ServerOff,
  Trash2
} from 'lucide-react'
import type {
  SshTarget,
  SshConnectionState,
  SshConnectionStatus
} from '../../../../shared/ssh-types'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

// ── Shared status helpers ────────────────────────────────────────────

export const STATUS_LABELS: Record<SshConnectionStatus, string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting\u2026',
  'auth-failed': 'Auth failed',
  'deploying-relay': 'Deploying relay\u2026',
  connected: 'Connected',
  reconnecting: 'Reconnecting\u2026',
  'reconnection-failed': 'Reconnection failed',
  error: 'Error'
}

export function statusColor(status: SshConnectionStatus): string {
  switch (status) {
    case 'connected':
      return 'bg-emerald-500'
    case 'connecting':
    case 'deploying-relay':
    case 'reconnecting':
      return 'bg-yellow-500'
    case 'auth-failed':
    case 'reconnection-failed':
    case 'error':
      return 'bg-red-500'
    default:
      return 'bg-muted-foreground/40'
  }
}

export function isConnecting(status: SshConnectionStatus): boolean {
  return ['connecting', 'deploying-relay', 'reconnecting'].includes(status)
}

// ── SshTargetCard ────────────────────────────────────────────────────

type SshTargetCardProps = {
  target: SshTarget
  state: SshConnectionState | undefined
  testing: boolean
  onConnect: (targetId: string) => void
  onDisconnect: (targetId: string) => void
  onTerminateSessions: (targetId: string) => void
  onTest: (targetId: string) => void
  onEdit: (target: SshTarget) => void
  onRemove: (targetId: string) => void
}

export function SshTargetCard({
  target,
  state,
  testing,
  onConnect,
  onDisconnect,
  onTerminateSessions,
  onTest,
  onEdit,
  onRemove
}: SshTargetCardProps): React.JSX.Element {
  const status: SshConnectionStatus = state?.status ?? 'disconnected'
  const [actionInFlight, setActionInFlight] = useState<
    'connect' | 'disconnect' | 'terminate' | null
  >(null)

  const handleConnect = (): void => {
    if (actionInFlight) {
      return
    }
    setActionInFlight('connect')
    Promise.resolve(onConnect(target.id)).finally(() => setActionInFlight(null))
  }

  const handleDisconnect = (): void => {
    if (actionInFlight) {
      return
    }
    setActionInFlight('disconnect')
    Promise.resolve(onDisconnect(target.id)).finally(() => setActionInFlight(null))
  }

  const handleTerminateSessions = (): void => {
    if (actionInFlight) {
      return
    }
    setActionInFlight('terminate')
    Promise.resolve(onTerminateSessions(target.id)).finally(() => setActionInFlight(null))
  }

  const renderEndRemoteTerminalsButton = (): React.JSX.Element => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleTerminateSessions}
          className="size-7 text-muted-foreground hover:text-red-400"
          disabled={actionInFlight !== null}
          aria-label={
            actionInFlight === 'terminate' ? 'Ending remote terminals' : 'End remote terminals'
          }
        >
          {actionInFlight === 'terminate' ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <CircleStop className="size-3" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        End remote terminals
      </TooltipContent>
    </Tooltip>
  )

  const renderSecondaryIconActions = (includeEndRemoteTerminals: boolean): React.JSX.Element => (
    <div className="flex items-center gap-1">
      {includeEndRemoteTerminals ? renderEndRemoteTerminalsButton() : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onEdit(target)}
            className="size-7"
            aria-label="Edit target"
          >
            <Pencil className="size-3" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          Edit target
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onRemove(target.id)}
            className="size-7 text-muted-foreground hover:text-red-400"
            aria-label="Remove target"
          >
            <Trash2 className="size-3" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          Remove target
        </TooltipContent>
      </Tooltip>
    </div>
  )

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/50 bg-card/40 px-4 py-3">
      <Server className="size-4 shrink-0 text-muted-foreground" />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{target.label}</span>
          <span className={`size-2 shrink-0 rounded-full ${statusColor(status)}`} />
          <span className="text-[11px] text-muted-foreground">{STATUS_LABELS[status]}</span>
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {target.username}@{target.host}:{target.port}
          {target.identityFile ? ` \u2022 ${target.identityFile}` : ''}
        </p>
        {state?.error ? (
          <p className="mt-0.5 truncate text-xs text-red-400">{state.error}</p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {status === 'connected' ? (
          <>
            {renderSecondaryIconActions(true)}
            <Button
              variant="ghost"
              size="xs"
              onClick={handleDisconnect}
              className="gap-1.5"
              disabled={actionInFlight !== null}
            >
              <ServerOff className="size-3" />
              Disconnect
            </Button>
          </>
        ) : isConnecting(status) ? (
          <>
            {renderSecondaryIconActions(false)}
            <Button variant="ghost" size="xs" disabled className="gap-1.5">
              <Loader2 className="size-3 animate-spin" />
              Connecting
            </Button>
          </>
        ) : (
          <>
            {renderSecondaryIconActions(true)}
            <Button
              variant="ghost"
              size="xs"
              onClick={() => onTest(target.id)}
              disabled={testing}
              className="gap-1.5"
            >
              {testing ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <MonitorSmartphone className="size-3" />
              )}
              Test
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={handleConnect}
              className="gap-1.5"
              disabled={actionInFlight !== null}
            >
              {actionInFlight === 'connect' ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Server className="size-3" />
              )}
              Connect
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
