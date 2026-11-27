import { useId, useState } from 'react'
import { LoaderCircle, Lock } from 'lucide-react'
import type { ItsaplanFailure } from '../../../shared/itsaplan/itsaplan-types'
import { useAppStore } from '@/store/index'
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
import { preventOutsideDismissWhenDirty } from '@/lib/overlay-interaction/outside-dismiss-guard'
import { useTranslate } from '@/i18n/use-translate'
import type { Translate } from '@/i18n/use-translate'

type ItsaplanConnectDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type ConnectState = 'idle' | 'detecting' | 'connecting' | 'error'

function failureMessage(failure: ItsaplanFailure, t: Translate): string {
  switch (failure.error) {
    case 'invalidUrl':
      return t(
        'components.itsaplanConnectDialog.errors.invalidUrl',
        "Enter a valid It's a Plan URL."
      )
    case 'apiNotFound':
      return t(
        'components.itsaplanConnectDialog.errors.apiNotFound',
        'Could not find the API for this URL. Enter the API URL manually.'
      )
    case 'invalidApiKey':
      return t(
        'components.itsaplanConnectDialog.errors.invalidApiKey',
        'API key invalid. Check the key and try again.'
      )
    case 'unreachable':
      return t(
        'components.itsaplanConnectDialog.errors.unreachable',
        "Could not reach It's a Plan. Check the URL and your network."
      )
    case 'forbidden':
    case 'notConnected':
    case 'notFound':
    case 'rateLimited':
    case 'requestFailed':
      return failure.message
  }
}

export function ItsaplanConnectDialog({
  open,
  onOpenChange
}: ItsaplanConnectDialogProps): React.JSX.Element {
  const t = useTranslate()
  const connectItsaplan = useAppStore((s) => s.connectItsaplan)
  const detectItsaplanApiUrl = useAppStore((s) => s.detectItsaplanApiUrl)
  const mountedRef = useMountedRef()
  const appUrlId = useId()
  const apiKeyId = useId()
  const apiUrlId = useId()
  const errorId = useId()

  const [appUrl, setAppUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [apiUrl, setApiUrl] = useState('')
  const [apiUrlEdited, setApiUrlEdited] = useState(false)
  const [state, setState] = useState<ConnectState>('idle')
  const [error, setError] = useState<string | null>(null)

  // Clear the key and errors before paint on each open so prior credentials cannot flash.
  const [prevOpen, setPrevOpen] = useState(open)
  if (prevOpen !== open) {
    setPrevOpen(open)
    if (open) {
      setAppUrl('')
      setApiKey('')
      setApiUrl('')
      setApiUrlEdited(false)
      setState('idle')
      setError(null)
    }
  }

  const canSubmit = Boolean(appUrl.trim()) && Boolean(apiKey.trim()) && state !== 'connecting'

  const clearErrorOnEdit = (): void => {
    if (state === 'error') {
      setState('idle')
      setError(null)
    }
  }

  const handleOpenChange = (nextOpen: boolean): void => {
    if (state !== 'connecting') {
      onOpenChange(nextOpen)
    }
  }

  const isDraftDirty = (): boolean => appUrl !== '' || apiKey !== '' || apiUrl !== ''
  const guardOutsideDismiss = preventOutsideDismissWhenDirty(isDraftDirty)

  const handleAppUrlBlur = async (): Promise<void> => {
    const trimmed = appUrl.trim()
    if (!trimmed || apiUrlEdited || state === 'detecting' || state === 'connecting') {
      return
    }
    setState('detecting')
    setError(null)
    try {
      const result = await detectItsaplanApiUrl(trimmed)
      if (!mountedRef.current) {
        return
      }
      if (result.ok) {
        setAppUrl(result.appUrl)
        setApiUrl(result.apiUrl)
        setState('idle')
        return
      }
      setState('error')
      setError(failureMessage(result, t))
    } catch (caught) {
      if (mountedRef.current) {
        setState('error')
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    }
  }

  const handleConnect = async (): Promise<void> => {
    const trimmedAppUrl = appUrl.trim()
    const trimmedApiKey = apiKey.trim()
    const trimmedApiUrl = apiUrl.trim()
    if (!trimmedAppUrl || !trimmedApiKey || state === 'connecting') {
      return
    }
    setState('connecting')
    setError(null)
    try {
      const result = await connectItsaplan({
        appUrl: trimmedAppUrl,
        ...(trimmedApiUrl ? { apiUrl: trimmedApiUrl } : {}),
        apiKey: trimmedApiKey
      })
      if (!mountedRef.current) {
        return
      }
      if (result.ok) {
        setAppUrl('')
        setApiKey('')
        setApiUrl('')
        setApiUrlEdited(false)
        setState('idle')
        onOpenChange(false)
        return
      }
      setState('error')
      setError(failureMessage(result, t))
    } catch (caught) {
      if (mountedRef.current) {
        setState('error')
        setError(
          caught instanceof Error
            ? caught.message
            : t('components.itsaplanConnectDialog.errors.connectionFailed', 'Connection failed')
        )
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        overlayClassName="z-[110]"
        className="z-[120] sm:max-w-md"
        onPointerDownOutside={guardOutsideDismiss}
        onInteractOutside={guardOutsideDismiss}
      >
        <DialogHeader>
          <DialogTitle>
            {t('components.itsaplanConnectDialog.title', "Connect It's a Plan")}
          </DialogTitle>
          <DialogDescription>
            {t(
              'components.itsaplanConnectDialog.description',
              "Use your It's a Plan URL and an API key to browse issues."
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
              <Label htmlFor={appUrlId} variant="settings">
                {t('components.itsaplanConnectDialog.appUrl', 'App URL')}
              </Label>
              <Input
                id={appUrlId}
                autoFocus
                placeholder={t(
                  'components.itsaplanConnectDialog.appUrlPlaceholder',
                  'https://plan.example.com'
                )}
                value={appUrl}
                onChange={(event) => {
                  setAppUrl(event.target.value)
                  // A new App URL invalidates the previous detection and any manual API URL.
                  setApiUrl('')
                  setApiUrlEdited(false)
                  clearErrorOnEdit()
                }}
                onBlur={() => void handleAppUrlBlur()}
                disabled={state === 'connecting'}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={apiKeyId} variant="settings">
                {t('components.itsaplanConnectDialog.apiKey', 'API key')}
              </Label>
              <Input
                id={apiKeyId}
                type="password"
                autoComplete="off"
                placeholder={t('components.itsaplanConnectDialog.apiKeyPlaceholder', 'API key')}
                value={apiKey}
                onChange={(event) => {
                  setApiKey(event.target.value)
                  clearErrorOnEdit()
                }}
                disabled={state === 'connecting'}
                aria-describedby={state === 'error' ? errorId : undefined}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={apiUrlId} variant="settings">
                {t('components.itsaplanConnectDialog.apiUrl', 'API URL')}
              </Label>
              <Input
                id={apiUrlId}
                placeholder={
                  state === 'detecting'
                    ? t('components.itsaplanConnectDialog.detecting', 'Detecting…')
                    : t(
                        'components.itsaplanConnectDialog.apiUrlPlaceholder',
                        'https://api.plan.example.com'
                      )
                }
                value={apiUrl}
                onChange={(event) => {
                  setApiUrl(event.target.value)
                  setApiUrlEdited(true)
                  clearErrorOnEdit()
                }}
                disabled={state === 'connecting'}
              />
            </div>
            {state === 'error' && error ? (
              <p id={errorId} role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {t(
                'components.itsaplanConnectDialog.guide',
                "Create an API key in It's a Plan under /account/api-keys."
              )}
            </p>
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
              <Lock className="size-3 shrink-0" />
              {t(
                'components.itsaplanConnectDialog.storage',
                'The API key is stored locally and encrypted when local storage supports it.'
              )}
            </p>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={state === 'connecting'}
            >
              {t('components.itsaplanConnectDialog.cancel', 'Cancel')}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {state === 'connecting' ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" />
                  {t('components.itsaplanConnectDialog.verifying', 'Verifying…')}
                </>
              ) : (
                t('components.itsaplanConnectDialog.connect', 'Connect')
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
