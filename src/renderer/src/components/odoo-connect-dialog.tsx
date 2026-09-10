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

type OdooConnectDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnected?: () => void
  overlayClassName?: string
  contentClassName?: string
}

type ConnectState = 'idle' | 'connecting' | 'error'

export function OdooConnectDialog({
  open,
  onOpenChange,
  onConnected,
  overlayClassName,
  contentClassName
}: OdooConnectDialogProps): React.JSX.Element {
  const connectOdoo = useAppStore((s) => s.connectOdoo)
  const settings = useAppStore((s) => s.settings)
  const mountedRef = useMountedRef()
  const serverUrlId = useId()
  const databaseId = useId()
  const loginId = useId()
  const apiKeyId = useId()
  const errorId = useId()

  const [serverUrl, setServerUrl] = useState('')
  const [database, setDatabase] = useState('')
  const [login, setLogin] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [connectState, setConnectState] = useState<ConnectState>('idle')
  const [connectError, setConnectError] = useState<string | null>(null)

  // Start every open with a clean slate so a previously-typed secret or old
  // error can't linger across reopens. Runs before paint so a stale credential
  // never renders for a frame.
  useLayoutEffect(() => {
    if (!open) {
      return
    }
    setServerUrl('')
    setDatabase('')
    setLogin('')
    setApiKey('')
    setConnectState('idle')
    setConnectError(null)
  }, [open])

  const canSubmit =
    Boolean(serverUrl.trim()) &&
    Boolean(database.trim()) &&
    Boolean(login.trim()) &&
    Boolean(apiKey.trim()) &&
    connectState !== 'connecting'
  const credentialStorageCopy = hasRemoteProviderRuntime(settings)
    ? translate(
        'auto.components.odoo.connect.dialog.0d81b37e29',
        'Your API key is sent to the selected remote runtime and stored there with runtime-supported encryption.'
      )
    : translate(
        'auto.components.odoo.connect.dialog.5d8ac0509d',
        'Your API key is stored locally and encrypted when local runtime storage supports it.'
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
    const trimmedServer = serverUrl.trim()
    const trimmedDatabase = database.trim()
    const trimmedLogin = login.trim()
    const trimmedKey = apiKey.trim()
    if (
      !trimmedServer ||
      !trimmedDatabase ||
      !trimmedLogin ||
      !trimmedKey ||
      connectState === 'connecting'
    ) {
      return
    }
    setConnectState('connecting')
    setConnectError(null)
    try {
      const result = await connectOdoo({
        serverUrl: trimmedServer,
        database: trimmedDatabase,
        login: trimmedLogin,
        apiKey: trimmedKey
      })
      if (!mountedRef.current) {
        return
      }
      if (result.ok) {
        setServerUrl('')
        setDatabase('')
        setLogin('')
        setApiKey('')
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
          error instanceof Error
            ? error.message
            : translate('auto.components.odoo.connect.dialog.53ad73eb2d', 'Connection failed')
        )
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
            {translate('auto.components.odoo.connect.dialog.e4c06861c0', 'Connect Odoo server')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.odoo.connect.dialog.79831c1057',
              'Use your Odoo server URL, database, login, and API key to browse tickets.'
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
              <Label htmlFor={serverUrlId} className="text-xs">
                {translate('auto.components.odoo.connect.dialog.a0859126fa', 'Odoo server URL')}
              </Label>
              <Input
                id={serverUrlId}
                autoFocus
                placeholder={translate(
                  'auto.components.odoo.connect.dialog.b9ff33a00d',
                  'https://odoo.example.com'
                )}
                value={serverUrl}
                onChange={(event) => {
                  setServerUrl(event.target.value)
                  clearErrorOnEdit()
                }}
                disabled={connectState === 'connecting'}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={databaseId} className="text-xs">
                {translate('auto.components.odoo.connect.dialog.458a5cd247', 'Database')}
              </Label>
              <Input
                id={databaseId}
                placeholder={translate(
                  'auto.components.odoo.connect.dialog.17acc54e0a',
                  'mycompany'
                )}
                value={database}
                onChange={(event) => {
                  setDatabase(event.target.value)
                  clearErrorOnEdit()
                }}
                disabled={connectState === 'connecting'}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={loginId} className="text-xs">
                {translate('auto.components.odoo.connect.dialog.8568d8d7ee', 'Login')}
              </Label>
              <Input
                id={loginId}
                placeholder={translate(
                  'auto.components.odoo.connect.dialog.0dc046475d',
                  'you@example.com'
                )}
                value={login}
                onChange={(event) => {
                  setLogin(event.target.value)
                  clearErrorOnEdit()
                }}
                disabled={connectState === 'connecting'}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={apiKeyId} className="text-xs">
                {translate('auto.components.odoo.connect.dialog.11fb0827ed', 'API key')}
              </Label>
              <Input
                id={apiKeyId}
                type="password"
                placeholder={translate(
                  'auto.components.odoo.connect.dialog.c24a2b6fe2',
                  'Odoo API key'
                )}
                value={apiKey}
                onChange={(event) => {
                  setApiKey(event.target.value)
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
                'auto.components.odoo.connect.dialog.38baf57dd9',
                'Create an API key in Odoo under Preferences and Account Security.'
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
              {translate('auto.components.odoo.connect.dialog.d722ded40b', 'Cancel')}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {connectState === 'connecting' ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" />
                  {translate('auto.components.odoo.connect.dialog.b8d4744f56', 'Verifying…')}
                </>
              ) : (
                translate('auto.components.odoo.connect.dialog.ceb0150103', 'Connect')
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
