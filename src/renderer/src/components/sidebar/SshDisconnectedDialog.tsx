import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { Globe, Loader2, WifiOff } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { statusColor } from '@/components/settings/SshTargetCard'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'

type SshDisconnectedDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  targetId: string
  targetLabel: string
  status: SshConnectionStatus
}

const STATUS_MESSAGES: Partial<Record<SshConnectionStatus, string>> = {
  disconnected: 'This remote repository is not connected.',
  reconnecting: 'Reconnecting to the remote host...',
  'reconnection-failed': 'Reconnection to the remote host failed.',
  error: 'The connection to the remote host encountered an error.',
  'auth-failed': 'Authentication to the remote host failed.'
}

function isReconnectable(status: SshConnectionStatus): boolean {
  return ['disconnected', 'reconnection-failed', 'error', 'auth-failed'].includes(status)
}

export function SshDisconnectedDialog({
  open,
  onOpenChange,
  targetId,
  targetLabel,
  status
}: SshDisconnectedDialogProps): React.JSX.Element {
  const [connecting, setConnecting] = useState(false)

  const handleReconnect = useCallback(async () => {
    setConnecting(true)
    try {
      await window.api.ssh.connect({ targetId })
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Reconnection failed')
    } finally {
      setConnecting(false)
    }
  }, [targetId, onOpenChange])

  const isConnecting =
    connecting ||
    status === 'connecting' ||
    status === 'deploying-relay' ||
    status === 'reconnecting'
  const message = isConnecting
    ? 'Reconnecting to the remote host...'
    : (STATUS_MESSAGES[status] ?? 'This remote repository is not connected.')
  const showReconnect = isReconnectable(status)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm gap-3 p-5" showCloseButton={false}>
        <DialogHeader className="gap-1">
          <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
            {isConnecting ? (
              <Loader2 className="size-4 text-yellow-500 animate-spin" />
            ) : (
              <WifiOff className="size-4 text-muted-foreground" />
            )}
            {isConnecting ? 'Reconnecting...' : 'SSH Disconnected'}
          </DialogTitle>
          <DialogDescription className="text-xs">{message}</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2.5 rounded-md border border-border/50 bg-card/40 px-3 py-2">
          <Globe className="size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <span className="text-xs font-medium">{targetLabel}</span>
          </div>
          {isConnecting ? (
            <Loader2 className="size-3.5 shrink-0 text-yellow-500 animate-spin" />
          ) : (
            <span className={`size-1.5 shrink-0 rounded-full ${statusColor(status)}`} />
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={isConnecting}
          >
            Dismiss
          </Button>
          {showReconnect && (
            <Button size="sm" onClick={() => void handleReconnect()} disabled={isConnecting}>
              {isConnecting ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Connecting...
                </>
              ) : (
                'Reconnect'
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
