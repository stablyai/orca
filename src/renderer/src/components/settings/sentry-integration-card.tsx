import { useCallback, useEffect, useState } from 'react'
import type { SentryConnectionStatus } from '../../../../shared/sentry-types'
import { SentryConnectDialog } from '@/components/sentry-connect-dialog'
import { SentryIcon } from '@/components/icons/SentryIcon'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import {
  sentryDisconnect,
  sentryStatus,
  sentryTestConnection
} from '@/runtime/runtime-sentry-client'
import { IntegrationCardDetails, IntegrationCardShell } from './integration-card-shell'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

export function SentryIntegrationCard(): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const [status, setStatus] = useState<SentryConnectionStatus | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [testing, setTesting] = useState(false)

  const refresh = useCallback(() => {
    void sentryStatus(settings)
      .then(setStatus)
      .catch(() => setStatus({ connected: false, connection: null, organizations: [] }))
  }, [settings])

  useEffect(refresh, [refresh])

  const test = async (): Promise<void> => {
    setTesting(true)
    try {
      const result = await sentryTestConnection(settings)
      if (result.ok) {
        toast.success('Sentry connection works.')
      } else {
        toast.error(result.error)
      }
    } finally {
      setTesting(false)
    }
  }

  const connected = status?.connected === true
  return (
    <IntegrationCardShell
      icon={<SentryIcon className="size-5" />}
      name="Sentry"
      description={
        connected
          ? `${status.connection?.organization.name ?? 'Organization'} connected`
          : 'Browse and triage Sentry issues.'
      }
      checking={status === null}
      statusTone={connected ? 'connected' : 'attention'}
      statusLabel={connected ? 'Connected' : 'Not connected'}
      actions={
        <Button
          size="sm"
          variant={connected ? 'outline' : 'default'}
          onClick={() => setDialogOpen(true)}
        >
          {connected ? 'Change access' : 'Connect Sentry'}
        </Button>
      }
    >
      <IntegrationCardDetails>
        {connected ? (
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1 text-xs text-muted-foreground">
              <div className="truncate font-medium text-foreground">
                {status.connection?.organization.name}
              </div>
              <div className="truncate">{status.connection?.baseUrl}</div>
            </div>
            <Button variant="outline" size="sm" disabled={testing} onClick={() => void test()}>
              {testing ? <Loader2 className="size-3.5 animate-spin" /> : null}Test
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                void sentryDisconnect(settings).then(() => {
                  refresh()
                  window.dispatchEvent(new Event('sentry-connection-changed'))
                })
              }
            >
              Disconnect
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            The selected execution host stores the token. Tokens need event:read; triage needs
            event:write or event:admin.
          </p>
        )}
      </IntegrationCardDetails>
      <SentryConnectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        settings={settings}
        onConnected={(next) => {
          setStatus(next)
          window.dispatchEvent(new Event('sentry-connection-changed'))
        }}
      />
    </IntegrationCardShell>
  )
}
