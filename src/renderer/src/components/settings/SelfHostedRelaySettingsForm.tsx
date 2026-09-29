import { useId, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { translate } from '@/i18n/i18n'
import { useMountedRef } from '@/hooks/useMountedRef'
import type { MobileRelayStatusDetail } from '../../../../shared/mobile-relay-status'
import type { SelfHostedRelaySettings } from '../../../../shared/mobile-relay-provider'

export function SelfHostedRelaySettingsForm({
  status
}: {
  status: MobileRelayStatusDetail['selfHosted']
}): React.JSX.Element {
  const id = useId()
  const [url, setUrl] = useState(status?.url ?? '')
  const [accessKey, setAccessKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const visibleError = error || status?.error
  const mounted = useMountedRef()

  const configure = async (settings: SelfHostedRelaySettings | null): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const result = await window.api.mobile.configureSelfHostedRelay?.(settings)
      if (!result?.ok) {
        if (!mounted.current) {
          return
        }
        setError(
          result?.message ??
            translate(
              'mobile.selfHostedRelay.desktopOnly',
              'Configure the Relay in the desktop app.'
            )
        )
        return
      }
      if (mounted.current) {
        setAccessKey('')
        if (!settings) {
          setUrl('')
        }
      }
      toast.success(
        settings
          ? translate('mobile.selfHostedRelay.saved', 'Relay settings saved')
          : translate('mobile.selfHostedRelay.removed', 'Relay settings removed')
      )
    } catch {
      if (mounted.current) {
        setError(translate('mobile.selfHostedRelay.saveFailed', 'Could not save Relay settings.'))
      }
    } finally {
      if (mounted.current) {
        setBusy(false)
      }
    }
  }

  return (
    <form
      className="space-y-3 rounded-md border border-border p-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (!busy && url.trim() && accessKey.trim()) {
          void configure({ url, accessKey })
        }
      }}
    >
      <div className="space-y-1">
        <Label htmlFor={`${id}-url`}>{translate('mobile.selfHostedRelay.url', 'Relay URL')}</Label>
        <Input
          id={`${id}-url`}
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder={translate(
            'mobile.selfHostedRelay.urlPlaceholder',
            'https://relay.example.com'
          )}
          maxLength={2048}
          disabled={busy}
          required
          aria-invalid={Boolean(visibleError)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-key`}>{translate('mobile.selfHostedRelay.key', 'Access key')}</Label>
        <Input
          id={`${id}-key`}
          type="password"
          autoComplete="off"
          value={accessKey}
          onChange={(event) => setAccessKey(event.target.value)}
          maxLength={256}
          disabled={busy}
          required
          aria-invalid={Boolean(visibleError)}
        />
        <p className="text-xs text-muted-foreground">
          {translate(
            'mobile.selfHostedRelay.keyDescription',
            'Use the access key from your Relay server. It stays on this computer; phones pair by scanning a code.'
          )}
        </p>
      </div>
      {status?.configured ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'mobile.selfHostedRelay.editDescription',
            'Enter the key again to update settings. Changing the server or removing it disconnects phones using this Relay.'
          )}
        </p>
      ) : null}
      {visibleError ? (
        <p className="text-xs text-destructive" role="alert">
          {visibleError}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy || !url.trim() || !accessKey.trim()}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          {translate('mobile.selfHostedRelay.save', 'Save Relay')}
        </Button>
        {status?.configured || status?.error ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void configure(null)}
          >
            {translate('mobile.selfHostedRelay.remove', 'Remove configuration')}
          </Button>
        ) : null}
      </div>
    </form>
  )
}
