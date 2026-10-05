import { useId, useState } from 'react'
import { LoaderCircle, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { TASK_PROVIDERS, normalizeVisibleTaskProviders } from '../../../../shared/task-providers'
import { useYouTrackStore } from './youtrack-store'

/** Connecting is the opt-in for the hidden-by-default YouTrack provider. */
function showYouTrackInTasks(): void {
  const { settings, updateSettings } = useAppStore.getState()
  const visible = normalizeVisibleTaskProviders(settings?.visibleTaskProviders)
  if (!settings || visible.includes('youtrack')) {
    return
  }
  void updateSettings({
    visibleTaskProviders: TASK_PROVIDERS.filter(
      (provider) => provider === 'youtrack' || visible.includes(provider)
    )
  })
}

function hostOf(input: string | null): string | null {
  const trimmed = input?.trim()
  if (!trimmed) {
    return null
  }
  try {
    return new URL(
      /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    ).host.toLowerCase()
  } catch {
    return null
  }
}

/** True for plain-HTTP addresses off this machine, where the token would cross the network unencrypted. */
function sendsTokenInClearText(input: string): boolean {
  try {
    const url = new URL(input.trim())
    return url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}

export function YouTrackConnectDialog({
  open,
  onOpenChange,
  onConnected,
  aboveSettings = false
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConnected?: () => void
  /** Settings renders above the app shell; dialogs opened there must layer higher. */
  aboveSettings?: boolean
}): React.JSX.Element {
  const connect = useYouTrackStore((s) => s.connect)
  const savedBaseUrl = useYouTrackStore((s) => s.status.baseUrl)
  const [baseUrl, setBaseUrl] = useState(savedBaseUrl ?? '')
  const [token, setToken] = useState('')
  const savedAllowInsecureTls = useYouTrackStore((s) => s.status.allowInsecureTls === true)
  // Why per host: a saved certificate opt-out must never carry over to a different host.
  const [insecureTlsChoice, setInsecureTlsChoice] = useState(() => ({
    host: hostOf(savedBaseUrl),
    allow: savedAllowInsecureTls
  }))
  const allowInsecureTls = insecureTlsChoice.allow && insecureTlsChoice.host === hostOf(baseUrl)
  const insecureTlsId = useId()
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const baseUrlId = useId()
  const tokenId = useId()
  const canSubmit = baseUrl.trim().length > 0 && token.trim().length > 0 && !submitting

  const handleOpenChange = (next: boolean): void => {
    if (submitting) {
      return
    }
    if (!next) {
      setToken('')
      setError(null)
    }
    onOpenChange(next)
  }

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit) {
      return
    }
    setSubmitting(true)
    setError(null)
    const result = await connect(baseUrl, token, allowInsecureTls)
      .catch((reason: unknown) => ({
        ok: false as const,
        error: reason instanceof Error ? reason.message : String(reason)
      }))
      .finally(() => setSubmitting(false))
    if (!result.ok) {
      setError(result.error)
      return
    }
    setToken('')
    showYouTrackInTasks()
    onOpenChange(false)
    onConnected?.()
  }

  const tokenSettingsUrl = (() => {
    try {
      return baseUrl.trim()
        ? new URL('users/me?tab=account-security', `${baseUrl.trim().replace(/\/+$/, '')}/`).href
        : null
    } catch {
      return null
    }
  })()

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        overlayClassName={aboveSettings ? 'z-[110]' : undefined}
        className={aboveSettings ? 'z-[120] sm:max-w-md' : 'sm:max-w-md'}
      >
        <DialogHeader>
          <DialogTitle>{translate('youtrack.connect.title', 'Connect YouTrack')}</DialogTitle>
          <DialogDescription>
            {translate(
              'youtrack.connect.description',
              'Use your YouTrack address and a permanent token to browse and update issues.'
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void handleSubmit()
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor={baseUrlId}>
              {translate('youtrack.connect.baseUrl', 'YouTrack URL')}
            </Label>
            <Input
              id={baseUrlId}
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder={translate(
                'youtrack.connect.baseUrlPlaceholder',
                'https://youtrack.example.com'
              )}
              autoFocus
              disabled={submitting}
            />
            {sendsTokenInClearText(baseUrl) ? (
              <p className="text-xs text-destructive">
                {translate(
                  'youtrack.connect.httpWarning',
                  'This address uses http://, so your token would be sent unencrypted. Use https:// if your YouTrack supports it.'
                )}
              </p>
            ) : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={tokenId}>
              {translate('youtrack.connect.token', 'Permanent token')}
            </Label>
            <Input
              id={tokenId}
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder={translate('youtrack.connect.tokenPlaceholder', 'perm:…')}
              disabled={submitting}
            />
            <p className="text-xs text-muted-foreground">
              {translate(
                'youtrack.connect.tokenHint',
                'Create one under Profile → Account Security'
              )}
              {tokenSettingsUrl ? (
                <>
                  {' · '}
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs align-baseline"
                    onClick={() => void window.api.shell.openUrl(tokenSettingsUrl)}
                  >
                    {translate('youtrack.connect.openTokenSettings', 'open in YouTrack')}
                  </Button>
                </>
              ) : null}
            </p>
          </div>
          <div className="flex items-start gap-2">
            <Checkbox
              id={insecureTlsId}
              checked={allowInsecureTls}
              onCheckedChange={(checked) =>
                setInsecureTlsChoice({ host: hostOf(baseUrl), allow: checked === true })
              }
              disabled={submitting}
              className="mt-0.5"
            />
            <div className="grid gap-0.5">
              <Label htmlFor={insecureTlsId}>
                {translate('youtrack.connect.insecureTls', 'Skip certificate verification')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'youtrack.connect.insecureTlsHint',
                  'For self-signed or internal-CA certificates. Applies only to this YouTrack host; use it only on networks you trust.'
                )}
              </p>
            </div>
          </div>
          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <Lock className="mt-0.5 size-3 shrink-0" />
            {translate(
              'youtrack.connect.storageNote',
              'Your token is stored locally and encrypted when the OS keychain is available.'
            )}
          </p>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)}>
              {translate('youtrack.connect.cancel', 'Cancel')}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting ? <LoaderCircle className="size-4 animate-spin" /> : null}
              {translate('youtrack.connect.submit', 'Connect')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
