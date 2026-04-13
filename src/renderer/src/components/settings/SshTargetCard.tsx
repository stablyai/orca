import { Loader2, MonitorSmartphone, Pencil, Server, Trash2, Wifi, WifiOff } from 'lucide-react'
import type {
  SshTarget,
  SshConnectionState,
  SshConnectionStatus
} from '../../../../shared/ssh-types'
import { Button } from '../ui/button'

// ── Shared status helpers ────────────────────────────────────────────

export const STATUS_LABELS: Record<SshConnectionStatus, string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting\u2026',
  'host-key-verification': 'Verifying host key\u2026',
  'auth-challenge': 'Authenticating\u2026',
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
    case 'host-key-verification':
    case 'auth-challenge':
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
  return ['connecting', 'host-key-verification', 'auth-challenge', 'deploying-relay'].includes(
    status
  )
}

// ── SshTargetCard ────────────────────────────────────────────────────

type SshTargetCardProps = {
  target: SshTarget
  state: SshConnectionState | undefined
  testing: boolean
  onConnect: (targetId: string) => void
  onDisconnect: (targetId: string) => void
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
  onTest,
  onEdit,
  onRemove
}: SshTargetCardProps): React.JSX.Element {
  const status: SshConnectionStatus = state?.status ?? 'disconnected'

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
          <Button
            variant="ghost"
            size="xs"
            onClick={() => onDisconnect(target.id)}
            className="gap-1.5"
          >
            <WifiOff className="size-3" />
            Disconnect
          </Button>
        ) : isConnecting(status) ? (
          <Button variant="ghost" size="xs" disabled className="gap-1.5">
            <Loader2 className="size-3 animate-spin" />
            Connecting
          </Button>
        ) : (
          <>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => onConnect(target.id)}
              className="gap-1.5"
            >
              <Wifi className="size-3" />
              Connect
            </Button>
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
          </>
        )}

        <Button
          variant="ghost"
          size="icon"
          onClick={() => onEdit(target)}
          className="size-7"
          aria-label="Edit target"
        >
          <Pencil className="size-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onRemove(target.id)}
          className="size-7 text-muted-foreground hover:text-red-400"
          aria-label="Remove target"
        >
          <Trash2 className="size-3" />
        </Button>
      </div>
    </div>
  )
}
