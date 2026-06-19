import { useId, useState } from 'react'
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

type GlpiConnectDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnected?: () => void
  overlayClassName?: string
  contentClassName?: string
}

type ConnectState = 'idle' | 'connecting' | 'error'

// Why: mirrors the Jira connect dialog so onboarding and settings reuse one
// GLPI base-URL + app-token + user-token flow. GLPI's classic REST API needs an
// application token plus a per-user API token (see shared/glpi-types.ts).
export function GlpiConnectDialog({
  open,
  onOpenChange,
  onConnected,
  overlayClassName,
  contentClassName
}: GlpiConnectDialogProps): React.JSX.Element {
  const connectGlpi = useAppStore((s) => s.connectGlpi)
  const settings = useAppStore((s) => s.settings)
  const mountedRef = useMountedRef()
  const baseUrlId = useId()
  const appTokenId = useId()
  const userTokenId = useId()
  const errorId = useId()

  const [baseUrl, setBaseUrl] = useState('')
  const [appToken, setAppToken] = useState('')
  const [userToken, setUserToken] = useState('')
  const [connectState, setConnectState] = useState<ConnectState>('idle')
  const [connectError, setConnectError] = useState<string | null>(null)

  const canSubmit =
    Boolean(baseUrl.trim()) &&
    Boolean(appToken.trim()) &&
    Boolean(userToken.trim()) &&
    connectState !== 'connecting'
  const credentialStorageCopy = hasRemoteProviderRuntime(settings)
    ? translate(
        'auto.components.glpi.connect.dialog.cd43bfb3b7',
        'Your tokens are sent to the selected remote runtime and stored there with runtime-supported encryption.'
      )
    : translate(
        'auto.components.glpi.connect.dialog.c6dd841e4a',
        'Your tokens are stored locally and encrypted when local runtime storage supports it.'
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
    const trimmedBaseUrl = baseUrl.trim()
    const trimmedAppToken = appToken.trim()
    const trimmedUserToken = userToken.trim()
    if (!trimmedBaseUrl || !trimmedAppToken || !trimmedUserToken || connectState === 'connecting') {
      return
    }
    setConnectState('connecting')
    setConnectError(null)
    try {
      const result = await connectGlpi({
        baseUrl: trimmedBaseUrl,
        appToken: trimmedAppToken,
        userToken: trimmedUserToken
      })
      if (!mountedRef.current) {
        return
      }
      if (result.ok) {
        setBaseUrl('')
        setAppToken('')
        setUserToken('')
        setConnectState('idle')
        onOpenChange(false)
        onConnected?.()
        return
      }
      setConnectState('error')
      setConnectError(result.error ?? null)
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
            {translate('auto.components.glpi.connect.dialog.e8c6adc128', 'Connect GLPI server')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.glpi.connect.dialog.06db050839',
              'Use a GLPI URL with an application token and your user API token to browse tickets.'
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void handleConnect()
          }}
        >
          <div className="flex flex-col gap-3">
            <div className="space-y-2">
              <Label htmlFor={baseUrlId} className="text-xs">
                {translate('auto.components.glpi.connect.dialog.3924cbe054', 'GLPI URL')}
              </Label>
              <Input
                id={baseUrlId}
                autoFocus
                placeholder={translate(
                  'auto.components.glpi.connect.dialog.420f3239d2',
                  'https://glpi.example.com'
                )}
                value={baseUrl}
                onChange={(event) => {
                  setBaseUrl(event.target.value)
                  clearErrorOnEdit()
                }}
                disabled={connectState === 'connecting'}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={appTokenId} className="text-xs">
                {translate('auto.components.glpi.connect.dialog.fbcf3bd3e2', 'Application token')}
              </Label>
              <Input
                id={appTokenId}
                type="password"
                placeholder={translate(
                  'auto.components.glpi.connect.dialog.14e3d15891',
                  'GLPI App-Token'
                )}
                value={appToken}
                onChange={(event) => {
                  setAppToken(event.target.value)
                  clearErrorOnEdit()
                }}
                disabled={connectState === 'connecting'}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={userTokenId} className="text-xs">
                {translate('auto.components.glpi.connect.dialog.3b74f1e1ad', 'User API token')}
              </Label>
              <Input
                id={userTokenId}
                type="password"
                placeholder={translate(
                  'auto.components.glpi.connect.dialog.eac7eee953',
                  'Personal API token'
                )}
                value={userToken}
                onChange={(event) => {
                  setUserToken(event.target.value)
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
                'auto.components.glpi.connect.dialog.f596fdeb2c',
                'Generate the user API token in your GLPI preferences, under Remote access keys.'
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
              {translate('auto.components.glpi.connect.dialog.182d946c24', 'Cancel')}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {connectState === 'connecting' ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" />
                  {translate('auto.components.glpi.connect.dialog.56bb5fce21', 'Verifying…')}
                </>
              ) : (
                translate('auto.components.glpi.connect.dialog.c8c40b7e62', 'Connect')
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
