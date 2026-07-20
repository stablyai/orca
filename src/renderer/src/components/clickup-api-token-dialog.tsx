import { useId, useState } from 'react'
import { ExternalLink, Loader2, Lock } from 'lucide-react'
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
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { translate } from '@/i18n/i18n'

export function ClickUpApiTokenDialog({
  open,
  onOpenChange,
  onConnected
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnected?: () => void
}): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const connectClickUp = useAppStore((state) => state.connectClickUp)
  const mountedRef = useMountedRef()
  const inputId = useId()
  const errorId = useId()
  const [apiToken, setApiToken] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleOpenChange = (nextOpen: boolean): void => {
    if (submitting) {
      return
    }
    if (!nextOpen) {
      setApiToken('')
      setError(null)
    }
    onOpenChange(nextOpen)
  }

  const handleConnect = async (): Promise<void> => {
    const token = apiToken.trim()
    if (!token || submitting) {
      return
    }
    setSubmitting(true)
    setError(null)
    const result = await connectClickUp(token).catch((cause: unknown) => ({
      ok: false as const,
      error: cause instanceof Error ? cause.message : 'Connection failed.'
    }))
    if (!mountedRef.current) {
      return
    }
    setSubmitting(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setApiToken('')
    onOpenChange(false)
    onConnected?.()
  }

  const remote = getActiveRuntimeTarget(settings).kind === 'environment'

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && apiToken.trim() && !submitting) {
            event.preventDefault()
            void handleConnect()
          }
        }}
      >
        <DialogHeader className="gap-3">
          <DialogTitle>
            {translate('auto.components.clickup.dialog.title', 'Connect ClickUp')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.clickup.dialog.description',
              'Paste a Personal API token. Orca will load every ClickUp Workspace that token can access.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor={inputId} className="text-xs">
              {translate('auto.components.clickup.dialog.tokenLabel', 'Personal API token')}
            </Label>
            <Input
              id={inputId}
              autoFocus
              type="password"
              placeholder={translate('auto.components.clickup.token.placeholder', 'pk_...')}
              value={apiToken}
              onChange={(event) => {
                setApiToken(event.target.value)
                setError(null)
              }}
              disabled={submitting}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? errorId : undefined}
            />
          </div>
          {error ? (
            <p id={errorId} className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <p className="text-xs leading-relaxed text-muted-foreground">
            {translate(
              'auto.components.clickup.dialog.instructions',
              'Create the token from ClickUp Settings → Apps. Personal tokens inherit your account permissions.'
            )}{' '}
            <button
              type="button"
              className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
              onClick={() => window.api.shell.openUrl('https://app.clickup.com/settings/apps')}
            >
              {translate('auto.components.clickup.dialog.openSettings', 'Open ClickUp settings')}
              <ExternalLink className="size-3" />
            </button>
          </p>
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
            <Lock className="size-3 shrink-0" />
            {remote
              ? translate(
                  'auto.components.clickup.dialog.remoteStorage',
                  'The active remote runtime stores this token with runtime-supported encryption.'
                )
              : translate(
                  'auto.components.clickup.dialog.localStorage',
                  'This device stores the token with Electron encrypted storage when available.'
                )}
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={submitting}>
            {translate('auto.components.clickup.dialog.cancel', 'Cancel')}
          </Button>
          <Button onClick={() => void handleConnect()} disabled={!apiToken.trim() || submitting}>
            {submitting ? (
              <>
                <Loader2 className="animate-spin" />
                {translate('auto.components.clickup.dialog.connecting', 'Connecting…')}
              </>
            ) : (
              translate('auto.components.clickup.dialog.connect', 'Connect')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
