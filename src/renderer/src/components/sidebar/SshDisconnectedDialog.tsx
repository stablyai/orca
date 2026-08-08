import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, Server, ServerOff } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import { statusColor } from '@/components/settings/SshTargetCard'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'
import { useImeEnterGestureOwnership } from '@/lib/ime-composition-keyboard-event'

type SshDisconnectedDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  targetId: string
  targetLabel: string
  status: SshConnectionStatus
}

const STATUS_MESSAGES: Partial<Record<SshConnectionStatus, string>> = {
  get disconnected() {
    return translate(
      'auto.components.sidebar.SshDisconnectedDialog.disconnected',
      'This SSH host is not connected.'
    )
  },
  get reconnecting() {
    return translate(
      'auto.components.sidebar.SshDisconnectedDialog.reconnecting',
      'Reconnecting to the remote host...'
    )
  },
  get 'reconnection-failed'() {
    return translate(
      'auto.components.sidebar.SshDisconnectedDialog.reconnectionFailed',
      'Reconnection to the remote host failed.'
    )
  },
  get error() {
    return translate(
      'auto.components.sidebar.SshDisconnectedDialog.376bed88e5',
      'The connection to the remote host encountered an error.'
    )
  },
  get 'auth-failed'() {
    return translate(
      'auto.components.sidebar.SshDisconnectedDialog.authFailed',
      'Authentication to the remote host failed.'
    )
  }
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
  const imeEnter = useImeEnterGestureOwnership()
  const mountedRef = useMountedRef()

  const handleReconnect = useCallback(async () => {
    setConnecting(true)
    try {
      await window.api.ssh.connect({ targetId })
      if (mountedRef.current) {
        onOpenChange(false)
      }
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : translate(
              'auto.components.sidebar.SshDisconnectedDialog.656368f3a2',
              'Reconnection failed'
            )
      )
    } finally {
      if (mountedRef.current) {
        setConnecting(false)
      }
    }
  }, [mountedRef, targetId, onOpenChange])

  const isConnecting =
    connecting ||
    status === 'connecting' ||
    status === 'deploying-relay' ||
    status === 'reconnecting'
  const reconnectingMessage =
    STATUS_MESSAGES.reconnecting ??
    translate(
      'auto.components.sidebar.SshDisconnectedDialog.reconnecting',
      'Reconnecting to the remote host...'
    )
  const disconnectedMessage =
    STATUS_MESSAGES.disconnected ??
    translate(
      'auto.components.sidebar.SshDisconnectedDialog.disconnected',
      'This SSH host is not connected.'
    )
  const message = isConnecting
    ? reconnectingMessage
    : (STATUS_MESSAGES[status] ?? disconnectedMessage)
  const showReconnect = isReconnectable(status)

  useEffect(() => {
    // Window-level Enter handler. The dialog typically appears while focus
    // is inside an embedded terminal (xterm) or editor (monaco) that
    // aggressively reclaims focus, so dialog-scoped key handlers never
    // fire. Listening on window (capture phase) catches Enter regardless
    // of where focus actually lives while the dialog is open.
    if (!open || !showReconnect || isConnecting) {
      return undefined
    }
    const toImeEvent = (event: KeyboardEvent) => ({
      key: event.key,
      keyCode: event.keyCode,
      shiftKey: event.shiftKey,
      nativeEvent: event,
      preventDefault: () => event.preventDefault()
    })
    const onKeyDown = (event: KeyboardEvent): void => {
      if (imeEnter.ownsKeyDown(toImeEvent(event))) {
        return
      }
      if (event.key !== 'Enter' || event.defaultPrevented) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      void handleReconnect()
    }
    const onKeyUp = (event: KeyboardEvent): void => imeEnter.onKeyUp(toImeEvent(event))
    const onCompositionStart = (): void => imeEnter.setComposing(true)
    const onCompositionEnd = (): void => imeEnter.setComposing(false)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('compositionstart', onCompositionStart, true)
    window.addEventListener('compositionend', onCompositionEnd, true)
    window.addEventListener('blur', imeEnter.reset)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('compositionstart', onCompositionStart, true)
      window.removeEventListener('compositionend', onCompositionEnd, true)
      window.removeEventListener('blur', imeEnter.reset)
      imeEnter.reset()
    }
  }, [open, showReconnect, isConnecting, handleReconnect, imeEnter])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm gap-3 p-5" showCloseButton={false}>
        <DialogHeader className="gap-1">
          <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
            {isConnecting ? (
              <Loader2 className="size-4 text-yellow-500 animate-spin" />
            ) : (
              <ServerOff className="size-4 text-muted-foreground" />
            )}
            {isConnecting
              ? translate(
                  'auto.components.sidebar.SshDisconnectedDialog.cb5938ae79',
                  'Reconnecting...'
                )
              : translate(
                  'auto.components.sidebar.SshDisconnectedDialog.11552bf786',
                  'SSH Disconnected'
                )}
          </DialogTitle>
          <DialogDescription className="text-xs">{message}</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2.5 rounded-md border border-border/50 bg-card/40 px-3 py-2">
          <Server className="size-3.5 shrink-0 text-muted-foreground" />
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
            {translate('auto.components.sidebar.SshDisconnectedDialog.89385db176', 'Dismiss')}
          </Button>
          {showReconnect && (
            <Button size="sm" onClick={() => void handleReconnect()} disabled={isConnecting}>
              {isConnecting ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  {translate(
                    'auto.components.sidebar.SshDisconnectedDialog.ca4a7892af',
                    'Connecting...'
                  )}
                </>
              ) : (
                translate('auto.components.sidebar.SshDisconnectedDialog.4afcca1d24', 'Reconnect')
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
