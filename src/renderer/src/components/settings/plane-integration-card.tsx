import { useState } from 'react'
import { AlertCircle, Loader2, Unlink } from 'lucide-react'
import { PlaneIcon } from '@/components/icons/PlaneIcon'
import { PlaneConnectDialog } from '@/components/plane-connect-dialog'
import { Button } from '@/components/ui/button'
import { usePlaneConnection } from '@/hooks/usePlaneConnection'
import { translate } from '@/i18n/i18n'
import { planeDisconnect, planeTestConnection } from '@/runtime/runtime-plane-client'
import { useAppStore } from '@/store'
import { IntegrationCardDetails, IntegrationCardShell } from './integration-card-shell'
import { PLANE_INTEGRATION_SECTION_ID } from './task-provider-integration-section-ids'

export function PlaneIntegrationCard(): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const { status, checking, error, refresh } = usePlaneConnection()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testMessage, setTestMessage] = useState<string | null>(null)
  const workspaces = status.workspaces ?? []

  // Why: both calls reject on a timeout or an unsupported remote runtime.
  // Unhandled, the click handler produced an unhandled rejection and `testing`
  // stayed true, leaving the button spinning for good.
  const describeFailure = (cause: unknown): string =>
    cause instanceof Error
      ? cause.message
      : translate('auto.components.settings.PlaneIntegrationCard.failed', 'Plane request failed')

  const test = async (): Promise<void> => {
    setTesting(true)
    try {
      const result = await planeTestConnection(settings, {})
      setTestMessage(
        result.ok
          ? translate(
              'auto.components.settings.PlaneIntegrationCard.verified',
              'Connection verified'
            )
          : result.error
      )
    } catch (cause) {
      setTestMessage(describeFailure(cause))
    } finally {
      setTesting(false)
    }
  }

  const disconnect = async (): Promise<void> => {
    try {
      await planeDisconnect(settings)
      setTestMessage(null)
      await refresh()
    } catch (cause) {
      setTestMessage(describeFailure(cause))
    }
  }

  return (
    <>
      <IntegrationCardShell
        settingsSectionId={PLANE_INTEGRATION_SECTION_ID}
        icon={<PlaneIcon className="size-5" />}
        name="Plane"
        description={
          status.connected
            ? translate(
                'auto.components.settings.PlaneIntegrationCard.connectedDescription',
                '{{count}} workspace connected',
                { count: workspaces.length || 1 }
              )
            : translate(
                'auto.components.settings.PlaneIntegrationCard.description',
                'Browse and start work from Plane Cloud or self-hosted work items.'
              )
        }
        checking={checking}
        statusTone={status.connected ? 'connected' : 'attention'}
        statusLabel={
          status.connected
            ? translate('auto.components.settings.PlaneIntegrationCard.connected', 'Connected')
            : translate(
                'auto.components.settings.PlaneIntegrationCard.notConnected',
                'Not connected'
              )
        }
        actions={
          !checking ? (
            <Button
              size="sm"
              variant={status.connected ? 'outline' : 'default'}
              onClick={() => setDialogOpen(true)}
            >
              {status.connected
                ? translate('auto.components.settings.PlaneIntegrationCard.add', 'Add workspace')
                : translate(
                    'auto.components.settings.PlaneIntegrationCard.connect',
                    'Connect Plane'
                  )}
            </Button>
          ) : null
        }
      >
        <IntegrationCardDetails>
          {error ? (
            <p className="flex items-center gap-2 text-xs text-destructive">
              <AlertCircle className="size-3.5" />
              {error}
            </p>
          ) : null}
          {status.connected ? (
            <div className="space-y-2">
              {workspaces.map((workspace) => (
                <div key={workspace.id} className="text-xs">
                  <p className="font-medium text-foreground">{workspace.name}</p>
                  <p className="text-muted-foreground">
                    {workspace.baseUrl} · {workspace.slug}
                  </p>
                </div>
              ))}
              {testMessage ? <p className="text-xs text-muted-foreground">{testMessage}</p> : null}
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={testing} onClick={() => void test()}>
                  {testing ? <Loader2 className="animate-spin" /> : null}
                  {translate('auto.components.settings.PlaneIntegrationCard.test', 'Test')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void disconnect()}>
                  <Unlink />
                  {translate(
                    'auto.components.settings.PlaneIntegrationCard.disconnect',
                    'Disconnect'
                  )}
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.PlaneIntegrationCard.help',
                'Connect with a workspace slug and personal access token. Credentials are stored by the active runtime.'
              )}
            </p>
          )}
        </IntegrationCardDetails>
      </IntegrationCardShell>
      <PlaneConnectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onConnected={() => void refresh()}
      />
    </>
  )
}
