import { useEffect, useId, useMemo, useState } from 'react'
import { KanbanSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { getKaneoApi } from '@/runtime/runtime-kaneo-client'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import type { KaneoConnectionStatus } from '../../../../shared/kaneo-types'
import { IntegrationCardDetails, IntegrationCardShell } from './integration-card-shell'

export function KaneoIntegrationCard(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const contextKey = getProviderRuntimeContextKey(settings)
  return (
    <KaneoConnectionForm key={contextKey} environmentId={settings?.activeRuntimeEnvironmentId} />
  )
}

function KaneoConnectionForm({
  environmentId
}: {
  environmentId?: string | null
}): React.JSX.Element {
  const api = useMemo(
    () => getKaneoApi({ activeRuntimeEnvironmentId: environmentId }),
    [environmentId]
  )
  const id = useId()
  const [status, setStatus] = useState<KaneoConnectionStatus | null>(null)
  const [siteUrl, setSiteUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [editing, setEditing] = useState(false)
  const [statusAttempt, setStatusAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void api
      .status()
      .then((value) => {
        if (!cancelled) {
          setStatus(value)
          setSiteUrl(value.siteUrl ?? '')
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setError(
            extractIpcErrorMessage(error, translate('kaneo.requestFailed', 'Kaneo request failed.'))
          )
        }
      })
    return () => {
      cancelled = true
    }
  }, [api, statusAttempt])
  async function run(action: 'connect' | 'disconnect') {
    if (busy) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (action === 'connect') {
        setStatus(await api.connect({ siteUrl, apiKey }))
      } else {
        await api.disconnect()
        setStatus({ connected: false, siteUrl: null })
      }
      setApiKey('')
      setEditing(false)
    } catch (error) {
      setError(
        extractIpcErrorMessage(error, translate('kaneo.requestFailed', 'Kaneo request failed.'))
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <IntegrationCardShell
      icon={<KanbanSquare className="size-5" />}
      name="Kaneo"
      settingsSectionId="kaneo-integration"
      description={translate(
        'kaneo.integration.description',
        'Paste a Kaneo task URL to start a workspace with linked task context.'
      )}
      statusLabel={
        status?.connected
          ? translate('kaneo.connected', 'Connected')
          : translate('kaneo.disconnected', 'Not connected')
      }
      statusTone={status?.connected ? 'connected' : 'neutral'}
      checking={!status && !error}
      actions={
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || !status}
            onClick={() => setEditing(!editing)}
          >
            {status?.connected
              ? translate('kaneo.configure', 'Configure')
              : translate('kaneo.connect', 'Connect Kaneo')}
          </Button>
          {status?.connected ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void run('disconnect')}
            >
              {translate('kaneo.disconnect', 'Disconnect')}
            </Button>
          ) : null}
        </>
      }
    >
      {status?.siteUrl ? (
        <p className="mt-2 text-xs text-muted-foreground">{status.siteUrl}</p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {error && !status ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setError(null)
            setStatusAttempt((value) => value + 1)
          }}
        >
          {translate('kaneo.retry', 'Retry')}
        </Button>
      ) : null}
      {editing ? (
        <IntegrationCardDetails>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              void run('connect')
            }}
          >
            <div className="space-y-1">
              <Label htmlFor={`${id}-site`}>{translate('kaneo.instanceUrl', 'Instance URL')}</Label>
              <Input
                id={`${id}-site`}
                type="url"
                placeholder={translate('kaneo.instanceUrlPlaceholder', 'https://kaneo.example.com')}
                value={siteUrl}
                onChange={(e) => setSiteUrl(e.target.value)}
                required
                disabled={busy}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-key`}>{translate('kaneo.apiKey', 'API key')}</Label>
              <Input
                id={`${id}-key`}
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                required
                disabled={busy}
              />
              <p className="text-xs text-muted-foreground">
                {translate(
                  'kaneo.keyHelp',
                  'Create an API key in Kaneo under Settings → Account → Developer Settings.'
                )}
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              {environmentId
                ? translate(
                    'kaneo.remoteCredential',
                    'Credentials are stored on the selected remote runtime using its credential storage.'
                  )
                : translate(
                    'kaneo.localCredential',
                    'Credentials are stored locally, encrypted when system credential storage is available.'
                  )}
            </p>
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" disabled={busy || !siteUrl.trim() || !apiKey.trim()}>
                {busy
                  ? translate('kaneo.connecting', 'Connecting…')
                  : translate('kaneo.saveConnection', 'Save connection')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setEditing(false)
                  setApiKey('')
                  setSiteUrl(status?.siteUrl ?? '')
                }}
              >
                {translate('kaneo.cancel', 'Cancel')}
              </Button>
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={() =>
                  void window.api.shell.openUrl(
                    'https://kaneo.app/docs/api-reference/authentication'
                  )
                }
              >
                {translate('kaneo.apiKeyHelp', 'API key help')}
              </Button>
            </div>
          </form>
        </IntegrationCardDetails>
      ) : null}
    </IntegrationCardShell>
  )
}
