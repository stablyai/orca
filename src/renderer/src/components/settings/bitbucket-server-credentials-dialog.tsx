import { useId, useLayoutEffect, useRef, useState } from 'react'
import { LoaderCircle, Lock } from 'lucide-react'
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
import { readIpcErrorMessage } from '@/lib/ipc-error'
import { translate } from '@/i18n/i18n'

type ConnectState = 'idle' | 'connecting' | 'error'

export function BitbucketServerCredentialsDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialBaseUrl?: string | null
  onConnected?: () => void
}): React.JSX.Element {
  const { open, onOpenChange, initialBaseUrl, onConnected } = props
  const mountedRef = useMountedRef()
  const baseUrlId = useId()
  const accessTokenId = useId()
  const errorId = useId()
  const [baseUrl, setBaseUrl] = useState('')
  const [accessToken, setAccessToken] = useState('')
  const [connectState, setConnectState] = useState<ConnectState>('idle')
  const [connectError, setConnectError] = useState<string | null>(null)
  const baselineBaseUrlRef = useRef('')

  // Re-seed on every open; the token always starts empty because main never returns it.
  useLayoutEffect(() => {
    if (!open) {
      return
    }
    baselineBaseUrlRef.current = initialBaseUrl ?? ''
    setBaseUrl(initialBaseUrl ?? '')
    setAccessToken('')
    setConnectState('idle')
    setConnectError(null)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- keyed on `open` alone: a status refresh mid-edit must not overwrite what the user is typing.
  }, [open])

  const connecting = connectState === 'connecting'
  const canSubmit = !connecting && Boolean(baseUrl.trim()) && Boolean(accessToken.trim())
  const guardOutsideDismiss = preventOutsideDismissWhenDirty(
    () => baseUrl !== baselineBaseUrlRef.current || accessToken !== ''
  )

  const clearErrorOnEdit = (): void => {
    if (connectState === 'error') {
      setConnectState('idle')
      setConnectError(null)
    }
  }

  const handleConnect = async (): Promise<void> => {
    if (!canSubmit) {
      return
    }
    setConnectState('connecting')
    setConnectError(null)
    try {
      const result = await window.api.bitbucketServer.connect({
        baseUrl: baseUrl.trim(),
        accessToken: accessToken.trim()
      })
      if (!mountedRef.current) {
        return
      }
      if (result.ok) {
        setAccessToken('')
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
        setConnectError(
          readIpcErrorMessage(error) ??
            translate(
              'auto.components.settings.bitbucket.server.credentials.dialog.connectFailed',
              'Connection failed'
            )
        )
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !connecting && onOpenChange(next)}>
      <DialogContent
        className="sm:max-w-lg"
        onPointerDownOutside={guardOutsideDismiss}
        onInteractOutside={guardOutsideDismiss}
        onKeyDown={(event) => {
          if (event.target instanceof HTMLInputElement && event.key === 'Enter' && canSubmit) {
            event.preventDefault()
            void handleConnect()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.settings.bitbucket.server.credentials.dialog.title',
              'Connect Bitbucket Data Center'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.settings.bitbucket.server.credentials.dialog.description',
              'Use a personal access token from your Bitbucket Data Center or Server to browse pull requests and build statuses. Orca verifies it before saving.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor={baseUrlId}>
              {translate(
                'auto.components.settings.bitbucket.server.credentials.dialog.baseUrl',
                'Server URL'
              )}
            </Label>
            <Input
              id={baseUrlId}
              autoFocus
              placeholder={translate(
                'auto.components.settings.bitbucket.server.credentials.dialog.baseUrlPlaceholder',
                'https://bitbucket.example.com'
              )}
              value={baseUrl}
              onChange={(event) => {
                setBaseUrl(event.target.value)
                clearErrorOnEdit()
              }}
              disabled={connecting}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={accessTokenId}>
              {translate(
                'auto.components.settings.bitbucket.server.credentials.dialog.accessToken',
                'Personal access token'
              )}
            </Label>
            <Input
              id={accessTokenId}
              type="password"
              value={accessToken}
              onChange={(event) => {
                setAccessToken(event.target.value)
                clearErrorOnEdit()
              }}
              disabled={connecting}
              aria-invalid={connectState === 'error'}
              aria-describedby={connectState === 'error' ? errorId : undefined}
            />
          </div>
          {connectState === 'error' && connectError ? (
            <p id={errorId} className="text-xs text-destructive">
              {connectError}
            </p>
          ) : null}
          <p className="text-xs leading-relaxed text-muted-foreground">
            {translate(
              'auto.components.settings.bitbucket.server.credentials.dialog.tokenHint',
              'Create the token under your Bitbucket profile > Manage account > Personal access tokens, with repository write access so Orca can create pull requests.'
            )}
          </p>
          <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground/70">
            <Lock className="mt-0.5 size-3 shrink-0" />
            {translate(
              'auto.components.settings.bitbucket.server.credentials.dialog.storageNote',
              'Stored on this machine with encrypted storage when the OS keychain is available, never on a remote runtime. ORCA_BITBUCKET_SERVER_BASE_URL and ORCA_BITBUCKET_SERVER_TOKEN, when both are set, take precedence over what you save here.'
            )}
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={connecting}>
            {translate(
              'auto.components.settings.bitbucket.server.credentials.dialog.cancel',
              'Cancel'
            )}
          </Button>
          <Button onClick={() => void handleConnect()} disabled={!canSubmit}>
            {connecting ? (
              <>
                <LoaderCircle className="size-4 animate-spin" />
                {translate(
                  'auto.components.settings.bitbucket.server.credentials.dialog.verifying',
                  'Verifying...'
                )}
              </>
            ) : (
              translate(
                'auto.components.settings.bitbucket.server.credentials.dialog.connect',
                'Connect'
              )
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
