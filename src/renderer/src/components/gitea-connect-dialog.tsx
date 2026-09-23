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
import { translate } from '@/i18n/i18n'

type GiteaConnectDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnected?: () => void
  overlayClassName?: string
  contentClassName?: string
}

type ConnectState = 'idle' | 'connecting' | 'error'

// Why: a self-hosted Gitea server is identified by its URL + a personal access
// token, so the connect flow mirrors the Jira site dialog but with two fields.
export function GiteaConnectDialog({
  open,
  onOpenChange,
  onConnected,
  overlayClassName,
  contentClassName
}: GiteaConnectDialogProps): React.JSX.Element {
  const giteaConnect = useAppStore((s) => s.giteaConnect)
  const mountedRef = useMountedRef()
  const baseUrlId = useId()
  const tokenId = useId()
  const errorId = useId()

  const [baseUrl, setBaseUrl] = useState('')
  const [token, setToken] = useState('')
  const [connectState, setConnectState] = useState<ConnectState>('idle')
  const [connectError, setConnectError] = useState<string | null>(null)

  const canSubmit =
    Boolean(baseUrl.trim()) && Boolean(token.trim()) && connectState !== 'connecting'

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
    const trimmedUrl = baseUrl.trim()
    const trimmedToken = token.trim()
    if (!trimmedUrl || !trimmedToken || connectState === 'connecting') {
      return
    }
    setConnectState('connecting')
    setConnectError(null)
    try {
      const result = await giteaConnect({ baseUrl: trimmedUrl, token: trimmedToken })
      if (!mountedRef.current) {
        return
      }
      if (result.ok) {
        setBaseUrl('')
        setToken('')
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
            {translate('auto.components.gitea.connect.dialog.d2823a1de0', 'Connect Gitea server')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.gitea.connect.dialog.d076a10ae3',
              'Use a Gitea server URL and a personal access token to browse and manage issues.'
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
                {translate('auto.components.gitea.connect.dialog.690c1da1bb', 'Gitea server URL')}
              </Label>
              <Input
                id={baseUrlId}
                autoFocus
                placeholder={translate(
                  'auto.components.gitea.connect.dialog.83b75fa9b7',
                  'https://gitea.example.com'
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
              <Label htmlFor={tokenId} className="text-xs">
                {translate('auto.components.gitea.connect.dialog.062ae1ea05', 'Access token')}
              </Label>
              <Input
                id={tokenId}
                type="password"
                placeholder={translate(
                  'auto.components.gitea.connect.dialog.79c04f358b',
                  'Gitea personal access token'
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
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.gitea.connect.dialog.3ecb3e1153',
                'Create a token under your Gitea user settings → Applications, with read/write access to issues.'
              )}
            </p>
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
              <Lock className="size-3 shrink-0" />
              {translate(
                'auto.components.gitea.connect.dialog.4d1f2d9f21',
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
              {translate('auto.components.gitea.connect.dialog.7acfed1da5', 'Cancel')}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {connectState === 'connecting' ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" />
                  {translate('auto.components.gitea.connect.dialog.f5d526570f', 'Verifying…')}
                </>
              ) : (
                translate('auto.components.gitea.connect.dialog.f68c3d011f', 'Connect')
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
