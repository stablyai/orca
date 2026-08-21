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
import { cn } from '@/lib/utils'
import { hasRemoteProviderRuntime } from '@/lib/provider-runtime-context'
import { translate } from '@/i18n/i18n'

type ClickUpConnectDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnected?: () => void
  overlayClassName?: string
  contentClassName?: string
}

type ConnectState = 'idle' | 'connecting' | 'error'

const CLICKUP_TOKEN_SETTINGS_URL = 'https://app.clickup.com/settings/apps'

/**
 * One personal API token reaches every ClickUp Workspace its owner belongs to,
 * so this dialog asks for the token alone — the Workspace list is discovered.
 */
export function ClickUpConnectDialog({
  open,
  onOpenChange,
  onConnected,
  overlayClassName,
  contentClassName
}: ClickUpConnectDialogProps): React.JSX.Element {
  const connectClickUp = useAppStore((s) => s.connectClickUp)
  const settings = useAppStore((s) => s.settings)
  const mountedRef = useMountedRef()
  const tokenId = useId()
  const errorId = useId()

  const [apiToken, setApiToken] = useState('')
  const [connectState, setConnectState] = useState<ConnectState>('idle')
  const [connectError, setConnectError] = useState<string | null>(null)

  // Start every open with a clean slate so a previously-typed secret or old
  // error cannot linger across reopens. Runs before paint so a stale credential
  // never renders for a frame.
  useLayoutEffect(() => {
    if (!open) {
      return
    }
    setApiToken('')
    setConnectState('idle')
    setConnectError(null)
  }, [open])

  const canSubmit = Boolean(apiToken.trim()) && connectState !== 'connecting'
  const credentialStorageCopy = hasRemoteProviderRuntime(settings)
    ? translate(
        'auto.components.clickup.connect.dialog.storage_remote',
        'Your token is sent to the selected remote runtime and stored there with runtime-supported encryption.'
      )
    : translate(
        'auto.components.clickup.connect.dialog.storage_local',
        'Your token is stored locally and encrypted when local runtime storage supports it.'
      )

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
    const trimmedToken = apiToken.trim()
    if (!trimmedToken || connectState === 'connecting') {
      return
    }
    setConnectState('connecting')
    setConnectError(null)
    try {
      const result = await connectClickUp({ apiToken: trimmedToken })
      if (!mountedRef.current) {
        return
      }
      if (result.ok) {
        setApiToken('')
        setConnectState('idle')
        onOpenChange(false)
        onConnected?.()
        return
      }
      setConnectState('error')
      setConnectError(result.error)
    } catch (error) {
      if (mountedRef.current) {
        setConnectState('error')
        setConnectError(error instanceof Error ? error.message : 'Connection failed')
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        overlayClassName={overlayClassName}
        className={cn('sm:max-w-md', contentClassName)}
      >
        <DialogHeader className="gap-3">
          <DialogTitle className="leading-tight">
            {translate('auto.components.clickup.connect.dialog.title', 'Connect ClickUp')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.clickup.connect.dialog.description',
              'Use a ClickUp personal API token to browse tasks. Every Workspace the token owner belongs to is added.'
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
              <Label htmlFor={tokenId} className="text-xs">
                {translate(
                  'auto.components.clickup.connect.dialog.token_label',
                  'Personal API token'
                )}
              </Label>
              <Input
                id={tokenId}
                type="password"
                placeholder="pk_00000000_XXXXXXXXXXXXXXXXXXXXXXXX"
                value={apiToken}
                onChange={(event) => {
                  setApiToken(event.target.value)
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
            <p className="text-xs text-muted-foreground">
              {translate('auto.components.clickup.connect.dialog.token_hint', 'Create a token in')}{' '}
              <button
                type="button"
                className="text-primary underline-offset-2 hover:underline"
                onClick={() => window.api.shell.openUrl(CLICKUP_TOKEN_SETTINGS_URL)}
              >
                {translate(
                  'auto.components.clickup.connect.dialog.token_hint_link',
                  'ClickUp Settings → Apps'
                )}
              </button>
              .
            </p>
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
              <Lock className="size-3 shrink-0" />
              {credentialStorageCopy}
            </p>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={connectState === 'connecting'}
            >
              {translate('auto.components.clickup.connect.dialog.cancel', 'Cancel')}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {connectState === 'connecting' ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" />
                  {translate('auto.components.clickup.connect.dialog.verifying', 'Verifying…')}
                </>
              ) : (
                translate('auto.components.clickup.connect.dialog.connect', 'Connect')
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
