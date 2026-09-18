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
import { hasRemoteProviderRuntime } from '@/lib/provider-runtime-context'
import { translate } from '@/i18n/i18n'

type MantisBTConnectDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnected?: () => void
  // Why: this dialog is sometimes opened from inside another already-open
  // dialog/sheet (the settings integration card); `elevated` raises it above
  // that ancestor instead of rendering underneath it. Kept as a closed
  // boolean (not a free className prop) so every class this component emits
  // stays statically readable.
  elevated?: boolean
}

type ConnectState = 'idle' | 'connecting' | 'error'

// Why: MantisBT has one auth shape (self-hosted base URL + API token) — no
// Cloud/Server split like Jira, so this dialog is simpler than JiraConnectDialog.
export function MantisBTConnectDialog({
  open,
  onOpenChange,
  onConnected,
  elevated
}: MantisBTConnectDialogProps): React.JSX.Element {
  const connectMantisBT = useAppStore((s) => s.connectMantisBT)
  const settings = useAppStore((s) => s.settings)
  const mountedRef = useMountedRef()
  const siteUrlId = useId()
  const tokenId = useId()
  const errorId = useId()

  const [siteUrl, setSiteUrl] = useState('')
  const [apiToken, setApiToken] = useState('')
  const [connectState, setConnectState] = useState<ConnectState>('idle')
  const [connectError, setConnectError] = useState<string | null>(null)

  // Start every open with a clean slate so a previously-typed secret or old
  // error can't linger across reopens. Runs before paint so a stale
  // credential never renders for a frame.
  useLayoutEffect(() => {
    if (!open) {
      return
    }
    setSiteUrl('')
    setApiToken('')
    setConnectState('idle')
    setConnectError(null)
  }, [open])

  const canSubmit =
    Boolean(siteUrl.trim()) && Boolean(apiToken.trim()) && connectState !== 'connecting'
  const credentialStorageCopy = hasRemoteProviderRuntime(settings)
    ? translate(
        'auto.components.mantisbt.connect.dialog.remoteStorageCopy',
        'Your token is sent to the selected remote runtime and stored there with runtime-supported encryption.'
      )
    : translate(
        'auto.components.mantisbt.connect.dialog.localStorageCopy',
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
    const trimmedSite = siteUrl.trim()
    const trimmedToken = apiToken.trim()
    if (!trimmedSite || !trimmedToken || connectState === 'connecting') {
      return
    }
    setConnectState('connecting')
    setConnectError(null)
    try {
      const result = await connectMantisBT({
        siteUrl: trimmedSite,
        apiToken: trimmedToken
      })
      if (!mountedRef.current) {
        return
      }
      if (result.ok) {
        setSiteUrl('')
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
        overlayClassName={elevated ? 'z-[110]' : undefined}
        className={elevated ? 'sm:max-w-md z-[120]' : 'sm:max-w-md'}
      >
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.mantisbt.connect.dialog.title', 'Connect MantisBT site')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.mantisbt.connect.dialog.description',
              'Use a self-hosted MantisBT base URL and an API token to browse issues.'
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
              <Label htmlFor={siteUrlId}>
                {translate('auto.components.mantisbt.connect.dialog.siteUrl', 'MantisBT site URL')}
              </Label>
              <Input
                id={siteUrlId}
                autoFocus
                placeholder={translate(
                  'auto.components.mantisbt.connect.dialog.siteUrlPlaceholder',
                  'https://mantisbt.example.com'
                )}
                value={siteUrl}
                onChange={(event) => {
                  setSiteUrl(event.target.value)
                  clearErrorOnEdit()
                }}
                disabled={connectState === 'connecting'}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={tokenId}>
                {translate('auto.components.mantisbt.connect.dialog.apiToken', 'API token')}
              </Label>
              <Input
                id={tokenId}
                type="password"
                placeholder={translate(
                  'auto.components.mantisbt.connect.dialog.apiTokenPlaceholder',
                  'MantisBT API token'
                )}
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
              {translate(
                'auto.components.mantisbt.connect.dialog.tokenHint',
                'Create an API token from your MantisBT account preferences.'
              )}
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
              {translate('auto.components.mantisbt.connect.dialog.cancel', 'Cancel')}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {connectState === 'connecting' ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" />
                  {translate('auto.components.mantisbt.connect.dialog.connecting', 'Verifying…')}
                </>
              ) : (
                translate('auto.components.mantisbt.connect.dialog.connect', 'Connect')
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
