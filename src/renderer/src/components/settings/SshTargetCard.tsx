import { useCallback, useRef, useState } from 'react'
import {
  CircleStop,
  Loader2,
  MonitorSmartphone,
  Pencil,
  RotateCcw,
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
import { isSshTargetConnecting, type SshTargetBusyAction } from './ssh-target-action-state'

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
    case 'disconnected':
      return 'bg-muted-foreground/40'
  }
}

// ── SshTargetCard ────────────────────────────────────────────────────

type SshTargetCardProps = {
  target: SshTarget
  state: SshConnectionState | undefined
  testing: boolean
  busyAction?: SshTargetBusyAction
  onConnect: (targetId: string) => void | Promise<void>
  onDisconnect: (targetId: string) => void | Promise<void>
  onTerminateSessions: (targetId: string) => void | Promise<void>
  onResetRelay: (targetId: string) => void | Promise<void>
  onTest: (targetId: string) => void | Promise<void>
  onEdit: (target: SshTarget) => void
  onRemove: (targetId: string) => void
}

export function SshTargetCard({
  target,
  state,
  testing,
  busyAction,
  onConnect,
  onDisconnect,
  onTerminateSessions,
  onResetRelay,
  onTest,
  onEdit,
  onRemove
}: SshTargetCardProps): React.JSX.Element {
  const status: SshConnectionStatus = state?.status ?? 'disconnected'
  const [actionInFlight, setActionInFlight] = useState<
    'connect' | 'disconnect' | 'terminate' | 'reset' | null
  >(null)
  const hasActionInFlight = actionInFlight !== null || busyAction !== undefined
  const terminateInFlight = actionInFlight === 'terminate' || busyAction === 'terminate'
  const resetInFlight = actionInFlight === 'reset' || busyAction === 'reset'
  const removeInFlight = busyAction === 'remove'
  const mountedRef = useRef(true)
  const endpoint = target.username
    ? `${target.username}@${target.host}:${target.port}`
    : `${target.host}:${target.port}`

  const handleCardRef = useCallback((node: HTMLDivElement | null): void => {
    // Why: SSH target actions can resolve after the card is removed; the root
    // ref gives async completions the same stale-write guard without an Effect.
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

  const handleTerminateSessions = (): void => {
    if (actionInFlight) {
      return
    }
    setActionInFlight('terminate')
    void Promise.resolve(onTerminateSessions(target.id)).finally(clearActionInFlight)
  }

  const handleResetRelay = (): void => {
    if (actionInFlight) {
      return
    }
    setActionInFlight('reset')
    void Promise.resolve(onResetRelay(target.id)).finally(clearActionInFlight)
  }

  const renderEndRemoteTerminalsButton = (): React.JSX.Element => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleTerminateSessions}
          className="size-7 text-muted-foreground hover:text-red-400"
          disabled={hasActionInFlight}
          aria-label={terminateInFlight ? 'Ending remote terminals' : 'End remote terminals'}
        >
          {terminateInFlight ? (
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

  const renderResetRelayButton = (): React.JSX.Element => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleResetRelay}
          className="size-7 text-muted-foreground hover:text-red-400"
          disabled={hasActionInFlight}
          aria-label={resetInFlight ? 'Resetting remote relay' : 'Reset remote relay'}
        >
          {resetInFlight ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <RotateCcw className="size-3" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        Reset remote relay
      </TooltipContent>
    </Tooltip>
  )

  const renderSecondaryIconActions = (includeEndRemoteTerminals: boolean): React.JSX.Element => (
    <div className="flex items-center gap-1">
      {includeEndRemoteTerminals ? renderEndRemoteTerminalsButton() : null}
      {isSshTargetConnecting(status) ? null : renderResetRelayButton()}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onEdit(target)}
            className="size-7"
            disabled={hasActionInFlight}
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
            disabled={hasActionInFlight}
            aria-label={removeInFlight ? 'Removing target' : 'Remove target'}
          >
            {removeInFlight ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Trash2 className="size-3" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          Remove target
        </TooltipContent>
      </Tooltip>
    </div>
  )

  return (
    <div
      ref={handleCardRef}
      className="flex items-center gap-3 rounded-lg border border-border/50 bg-card/40 px-4 py-3"
    >
      <Server className="size-4 shrink-0 text-muted-foreground" />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{target.label}</span>
          <span className={`size-2 shrink-0 rounded-full ${statusColor(status)}`} />
          <span className="text-[11px] text-muted-foreground">{STATUS_LABELS[status]}</span>
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {endpoint}
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
              disabled={hasActionInFlight}
            >
              <ServerOff className="size-3" />
              Disconnect
            </Button>
          </>
        ) : isSshTargetConnecting(status) ? (
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
              disabled={testing || hasActionInFlight}
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
              disabled={hasActionInFlight}
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
