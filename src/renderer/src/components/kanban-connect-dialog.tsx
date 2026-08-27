import { useId, useLayoutEffect, useState } from 'react'
import { LoaderCircle, Lock } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { KANBAN_SERVER_URL } from '../../../shared/kanban-types'
import { translate } from '@/i18n/i18n'

export type KanbanConnectDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnected?: () => void
  overlayClassName?: string
  contentClassName?: string
}

type ConnectState = 'idle' | 'connecting' | 'error'

// Why: Kanban v1 connects to one fixed server with a personal token only; the
// server URL is static copy, never an editable field, so the renderer cannot
// point the credential flow at an arbitrary host.
export function KanbanConnectDialog({
  open,
  onOpenChange,
  onConnected,
  overlayClassName,
  contentClassName
}: KanbanConnectDialogProps): React.JSX.Element {
  const tokenId = useId()
  const errorId = useId()
  const [token, setToken] = useState('')
  const [connectState, setConnectState] = useState<ConnectState>('idle')
  const [connectError, setConnectError] = useState<string | null>(null)

  useLayoutEffect(() => {
    if (!open) {
      return
    }
    setToken('')
    setConnectState('idle')
    setConnectError(null)
  }, [open])

  const canSubmit = token.trim().length > 0 && connectState !== 'connecting'

  const clearErrorOnEdit = (): void => {
    if (connectState === 'error') {
      setConnectState('idle')
      setConnectError(null)
    }
  }

  const handleOpenChange = (nextOpen: boolean): void => {
    if (connectState !== 'connecting') {
      onOpenChange(nextOpen)
    }
  }

  const handleConnect = async (): Promise<void> => {
    const trimmedToken = token.trim()
    if (!trimmedToken || connectState === 'connecting') {
      return
    }
    setConnectState('connecting')
    setConnectError(null)
    const result = await window.api.kanban.connect({ token: trimmedToken })
    if (result.ok) {
      setToken('')
      setConnectState('idle')
      onOpenChange(false)
      onConnected?.()
      return
    }
    setConnectState('error')
    setConnectError(result.error)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        overlayClassName={overlayClassName}
        className={cn('sm:max-w-md', contentClassName)}
      >
        <DialogHeader className="gap-3">
          <DialogTitle className="leading-tight">
            {translate('auto.components.kanban.connect.dialog.title', 'Connect Kanban')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.kanban.connect.dialog.description',
              'Use your personal Kanban token to browse and start work from your tasks.'
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            void handleConnect()
          }}
        >
          <div className="flex flex-col gap-3">
            <div className="space-y-2">
              <Label className="text-xs">
                {translate('auto.components.kanban.connect.dialog.server', 'Server')}
              </Label>
              <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/40 px-3 py-2 font-mono text-xs text-foreground">
                {KANBAN_SERVER_URL}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor={tokenId} className="text-xs">
                {translate('auto.components.kanban.connect.dialog.token', 'Personal token')}
              </Label>
              <Input
                id={tokenId}
                type="password"
                autoFocus
                placeholder={translate(
                  'auto.components.kanban.connect.dialog.tokenPlaceholder',
                  'Kanban personal token'
                )}
                value={token}
                onChange={(event) => {
                  setToken(event.target.value)
                  clearErrorOnEdit()
                }}
                disabled={connectState === 'connecting'}
                aria-invalid={connectState === 'error'}
                aria-describedby={connectState === 'error' ? errorId : undefined}
              />
            </div>
            {connectState === 'error' && connectError ? (
              <p id={errorId} className="text-xs text-destructive">
                {connectError}
              </p>
            ) : null}
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
              <Lock className="size-3 shrink-0" />
              {translate(
                'auto.components.kanban.connect.dialog.storage',
                'Your token is stored locally and encrypted when local runtime storage supports it.'
              )}
            </p>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={connectState === 'connecting'}
            >
              {translate('auto.components.kanban.connect.dialog.cancel', 'Cancel')}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {connectState === 'connecting' ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" />
                  {translate('auto.components.kanban.connect.dialog.verifying', 'Verifying:')}
                </>
              ) : (
                translate('auto.components.kanban.connect.dialog.connect', 'Connect')
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
