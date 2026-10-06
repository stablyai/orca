import { useId, useLayoutEffect, useState } from 'react'
import { LoaderCircle, Lock } from 'lucide-react'
import { useAppStore } from '@/store'
import { useMountedRef } from '@/hooks/useMountedRef'
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
import { preventOutsideDismissWhenDirty } from '@/lib/outside-dismiss-guard'
import { translate } from '@/i18n/i18n'

const TODOIST_TOKEN_SETTINGS_URL = 'https://app.todoist.com/app/settings/integrations/developer'

type TodoistConnectDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnected?: () => void
}

export function TodoistConnectDialog({
  open,
  onOpenChange,
  onConnected
}: TodoistConnectDialogProps): React.JSX.Element {
  const connectTodoist = useAppStore((s) => s.connectTodoist)
  const mountedRef = useMountedRef()
  const tokenId = useId()
  const errorId = useId()
  const [apiToken, setApiToken] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Why: never let a previously typed token render on reopen, even for a frame.
  useLayoutEffect(() => {
    if (open) {
      setApiToken('')
      setConnecting(false)
      setError(null)
    }
  }, [open])

  const guardOutsideDismiss = preventOutsideDismissWhenDirty(() => apiToken !== '')

  const handleConnect = async (): Promise<void> => {
    const token = apiToken.trim()
    if (!token || connecting) {
      return
    }
    setConnecting(true)
    setError(null)
    const result = await connectTodoist({ apiToken: token })
    if (!mountedRef.current) {
      return
    }
    setConnecting(false)
    if (result.ok) {
      setApiToken('')
      onOpenChange(false)
      onConnected?.()
      return
    }
    setError(result.error)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !connecting && onOpenChange(next)}>
      <DialogContent
        className="sm:max-w-md"
        onPointerDownOutside={guardOutsideDismiss}
        onInteractOutside={guardOutsideDismiss}
      >
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.todoist.connect.dialog.title', 'Connect Todoist')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.todoist.connect.dialog.description',
              'Use your Todoist API token to browse tasks and start workspaces from them.'
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
              <Label htmlFor={tokenId}>
                {translate('auto.components.todoist.connect.dialog.tokenLabel', 'API token')}
              </Label>
              <Input
                id={tokenId}
                type="password"
                autoFocus
                placeholder={translate(
                  'auto.components.todoist.connect.dialog.tokenPlaceholder',
                  'Todoist API token'
                )}
                value={apiToken}
                onChange={(event) => {
                  setApiToken(event.target.value)
                  setError(null)
                }}
                disabled={connecting}
                aria-invalid={error !== null}
                aria-describedby={error ? errorId : undefined}
              />
            </div>
            {error ? (
              <p id={errorId} className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.todoist.connect.dialog.tokenHint',
                'Copy your token from'
              )}{' '}
              <button
                type="button"
                className="text-primary underline-offset-2 hover:underline"
                onClick={() => window.api.shell.openUrl(TODOIST_TOKEN_SETTINGS_URL)}
              >
                {translate(
                  'auto.components.todoist.connect.dialog.tokenLink',
                  'Todoist integration settings'
                )}
              </button>
              .
            </p>
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
              <Lock className="size-3 shrink-0" />
              {translate(
                'auto.components.todoist.connect.dialog.storage',
                'Your token is stored locally and encrypted when local runtime storage supports it.'
              )}
            </p>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={connecting}
            >
              {translate('auto.components.todoist.connect.dialog.cancel', 'Cancel')}
            </Button>
            <Button type="submit" disabled={!apiToken.trim() || connecting}>
              {connecting ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" />
                  {translate('auto.components.todoist.connect.dialog.verifying', 'Verifying…')}
                </>
              ) : (
                translate('auto.components.todoist.connect.dialog.connect', 'Connect')
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
