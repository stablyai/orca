import { useId, useLayoutEffect, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
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
import { DEFAULT_VOLO_API_URL } from '../../../shared/volo-urls'

type VoloConnectDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnected?: () => void
}

type ConnectState = 'idle' | 'connecting' | 'error'

export function VoloConnectDialog({
  open,
  onOpenChange,
  onConnected
}: VoloConnectDialogProps): React.JSX.Element {
  const connectVoloWithGoogle = useAppStore((s) => s.connectVoloWithGoogle)
  const voloStatus = useAppStore((s) => s.voloStatus)
  const settings = useAppStore((s) => s.settings)
  const mountedRef = useMountedRef()
  const apiUrlId = useId()
  const errorId = useId()

  const [apiUrl, setApiUrl] = useState(DEFAULT_VOLO_API_URL)
  const [connectState, setConnectState] = useState<ConnectState>('idle')
  const [connectError, setConnectError] = useState<string | null>(null)

  useLayoutEffect(() => {
    if (!open) {
      return
    }
    setApiUrl(voloStatus.apiUrl || DEFAULT_VOLO_API_URL)
    setConnectState('idle')
    setConnectError(null)
  }, [open, voloStatus.apiUrl])

  const credentialStorageCopy = hasRemoteProviderRuntime(settings)
    ? translate(
        'auto.components.volo.connect.dialog.remoteStorage',
        'Sign in with Google here. The session is sent to the selected remote runtime and stored there with runtime-supported encryption.'
      )
    : voloStatus.hasSavedLocalCredentials
      ? translate(
          'auto.components.volo.connect.dialog.savedGoogle',
          'A Volo Google session is already saved on this computer. Continue reuses it, or signs in again if it expired.'
        )
      : translate(
          'auto.components.volo.connect.dialog.localStorage',
          'Opens Google sign-in in your browser. Same login as Volo.'
        )

  const finish = (ok: boolean, error?: string): void => {
    if (!mountedRef.current) {
      return
    }
    if (ok) {
      onOpenChange(false)
      onConnected?.()
      return
    }
    setConnectState('error')
    setConnectError(error ?? 'Could not connect to Volo.')
  }

  const handleGoogle = async (): Promise<void> => {
    setConnectState('connecting')
    setConnectError(null)
    const result = await connectVoloWithGoogle(apiUrl.trim() || DEFAULT_VOLO_API_URL)
    finish(result.ok, result.ok ? undefined : result.error)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.volo.connect.dialog.title', 'Connect Volo')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.volo.connect.dialog.description',
              'Sign in with your JAAK Google account to browse boards and start workspaces from tasks.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor={apiUrlId}>
              {translate('auto.components.volo.connect.dialog.apiUrl', 'API URL')}
            </Label>
            <Input
              id={apiUrlId}
              value={apiUrl}
              onChange={(event) => {
                setApiUrl(event.target.value)
                if (connectState === 'error') {
                  setConnectState('idle')
                  setConnectError(null)
                }
              }}
              placeholder={DEFAULT_VOLO_API_URL}
            />
          </div>
          <p className="text-xs text-muted-foreground">{credentialStorageCopy}</p>
          {connectError ? (
            <p id={errorId} className="text-sm text-destructive">
              {connectError}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            disabled={connectState === 'connecting'}
            onClick={() => void handleGoogle()}
          >
            {connectState === 'connecting' ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              translate('auto.components.volo.connect.dialog.google', 'Continue with Google')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
