import { useState } from 'react'
import { AlertCircle, CheckCircle2, LoaderCircle, Unlink } from 'lucide-react'
import { GlpiConnectDialog } from '@/components/glpi-connect-dialog'
import { GlpiIcon } from '@/components/icons/GlpiIcon'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import {
  getProviderRuntimeContextKey,
  hasRemoteProviderRuntime
} from '@/lib/provider-runtime-context'
import { useAppStore } from '@/store'
import { IntegrationCardDetails, IntegrationCardShell } from './integration-card-shell'
import { getProviderAccountScope } from './provider-account-scope'
import { ProviderHostScopeControl } from './ProviderHostScopeControl'
import { translate } from '@/i18n/i18n'

type VerificationResult = { state: 'ok' | 'error'; error?: string }

export function GlpiTaskIntegrationCard(): React.JSX.Element {
  const glpiStatus = useAppStore((s) => s.glpiStatus)
  const glpiStatusChecked = useAppStore((s) => s.glpiStatusChecked)
  const glpiStatusContextKey = useAppStore((s) => s.glpiStatusContextKey)
  const checkGlpiConnection = useAppStore((s) => s.checkGlpiConnection)
  const disconnectGlpi = useAppStore((s) => s.disconnectGlpi)
  const testGlpiConnection = useAppStore((s) => s.testGlpiConnection)
  const settings = useAppStore((s) => s.settings)
  const mountedRef = useMountedRef()

  const [dialogOpen, setDialogOpen] = useState(false)
  const [testingServerId, setTestingServerId] = useState<string | null>(null)
  const [testResultByServer, setTestResultByServer] = useState<Record<string, VerificationResult>>(
    {}
  )

  const contextMatches = glpiStatusContextKey === getProviderRuntimeContextKey(settings)
  const checking = !contextMatches || !glpiStatusChecked
  const connected = contextMatches && glpiStatus.connected
  const servers = glpiStatus.servers ?? []
  const serverCount = servers.length || (connected ? 1 : 0)
  const accountScope = getProviderAccountScope(settings)
  const credentialError = contextMatches ? glpiStatus.credentialError : undefined
  const credentialCopy = hasRemoteProviderRuntime(settings)
    ? translate(
        'auto.components.settings.glpi.integration.card.e65c56123e',
        'Connect a GLPI server with an application token and your user API token. Credentials are sent to the selected remote runtime and stored there with runtime-supported encryption.'
      )
    : translate(
        'auto.components.settings.glpi.integration.card.4464e319b9',
        'Connect a GLPI server with an application token and your user API token. Credentials are stored locally and encrypted when local runtime storage supports it.'
      )

  const handleDisconnect = async (serverId?: string): Promise<void> => {
    await disconnectGlpi(serverId)
    if (mountedRef.current) {
      setTestResultByServer({})
    }
  }

  const handleTest = async (serverId: string): Promise<void> => {
    setTestingServerId(serverId)
    setTestResultByServer((prev) => {
      const next = { ...prev }
      delete next[serverId]
      return next
    })
    try {
      const result = await testGlpiConnection(serverId)
      if (!mountedRef.current) {
        return
      }
      setTestResultByServer((prev) => ({
        ...prev,
        [serverId]: result.ok ? { state: 'ok' } : { state: 'error', error: result.error }
      }))
    } finally {
      // Why: reset in finally so a thrown test call can't leave the button stuck.
      if (mountedRef.current) {
        setTestingServerId(null)
      }
    }
  }

  return (
    <IntegrationCardShell
      icon={<GlpiIcon className="size-5" />}
      name="GLPI"
      description={
        connected
          ? translate(
              'auto.components.settings.glpi.integration.card.9639e2d7f3',
              '{{value0}} server(s) connected',
              { value0: serverCount }
            )
          : checking
            ? translate(
                'auto.components.settings.glpi.integration.card.55adcb030c',
                'Checking GLPI access before showing setup actions.'
              )
            : translate(
                'auto.components.settings.glpi.integration.card.de87f5c922',
                'Browse, create, and start work from GLPI tickets.'
              )
      }
      checking={checking}
      statusTone={connected ? 'connected' : 'attention'}
      statusLabel={connected ? 'Connected' : 'Not connected'}
      actions={
        !checking ? (
          <Button
            variant={connected ? 'outline' : 'default'}
            size="sm"
            onClick={() => setDialogOpen(true)}
          >
            {connected
              ? translate('auto.components.settings.glpi.integration.card.30dcdc6acc', 'Add server')
              : translate(
                  'auto.components.settings.glpi.integration.card.6b75d2844f',
                  'Connect GLPI'
                )}
          </Button>
        ) : null
      }
    >
      <ProviderHostScopeControl
        labelPrefix={translate(
          'auto.components.settings.task.tracker.integration.cards.account_scope_prefix',
          'Account scope'
        )}
        scope={accountScope}
        className="mt-3 rounded-md border border-border/40 bg-background/50 px-3 py-2 text-xs"
      />
      {credentialError ? (
        <p className="mt-3 flex items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="size-3.5 shrink-0" />
          <span>{credentialError}</span>
        </p>
      ) : null}
      {connected && servers.length > 0 ? (
        <div className="mt-3 space-y-2">
          {servers.map((server) => {
            const testResult = testResultByServer[server.id]
            const testing = testingServerId === server.id
            return (
              <div
                key={server.id}
                className="flex items-center gap-3 rounded-md border border-border/50 bg-background/60 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {server.displayName}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {server.baseUrl}
                    {server.account ? ` · ${server.account}` : ''}
                  </p>
                </div>
                {testResult?.state === 'ok' ? (
                  <span className="flex shrink-0 items-center gap-1 text-xs text-status-success">
                    <CheckCircle2 className="size-3.5" />
                    {translate(
                      'auto.components.settings.glpi.integration.card.3907210261',
                      'Verified'
                    )}
                  </span>
                ) : null}
                {testResult?.state === 'error' ? (
                  <span className="flex min-w-0 max-w-[220px] shrink items-center gap-1 truncate text-xs text-destructive">
                    <AlertCircle className="size-3.5 shrink-0" />
                    <span className="truncate">{testResult.error}</span>
                  </span>
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleTest(server.id)}
                  disabled={testing}
                >
                  {testing ? (
                    <>
                      <LoaderCircle className="size-3.5 mr-1.5 animate-spin" />
                      {translate(
                        'auto.components.settings.glpi.integration.card.4faaa20f04',
                        'Testing...'
                      )}
                    </>
                  ) : (
                    translate('auto.components.settings.glpi.integration.card.d667078dfa', 'Test')
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => void handleDisconnect(server.id)}
                  aria-label={translate(
                    'auto.components.settings.glpi.integration.card.3652362824',
                    'Disconnect {{value0}}',
                    { value0: server.displayName }
                  )}
                  className="shrink-0 text-muted-foreground/50 hover:text-destructive"
                >
                  <Unlink className="size-3.5" />
                </Button>
              </div>
            )
          })}
          <p className="text-[11px] text-muted-foreground/70">
            {translate(
              'auto.components.settings.glpi.integration.card.d8dbdfc8a2',
              'Each connected GLPI server has its tokens stored by the active runtime.'
            )}
          </p>
        </div>
      ) : connected ? (
        <IntegrationCardDetails>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.glpi.integration.card.57dd44c500',
              'GLPI is connected for this runtime. Re-check if the connected server list looks stale.'
            )}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => void checkGlpiConnection()}>
              {translate('auto.components.settings.glpi.integration.card.1fa3a21f3a', 'Re-check')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void handleDisconnect()}>
              {translate('auto.components.settings.glpi.integration.card.3d50d105eb', 'Disconnect')}
            </Button>
          </div>
        </IntegrationCardDetails>
      ) : !checking ? (
        <IntegrationCardDetails>
          <p className="text-xs text-muted-foreground">{credentialCopy}</p>
          <Button variant="ghost" size="sm" onClick={() => void checkGlpiConnection()}>
            {translate('auto.components.settings.glpi.integration.card.1fa3a21f3a', 'Re-check')}
          </Button>
        </IntegrationCardDetails>
      ) : null}

      <GlpiConnectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onConnected={() => setTestResultByServer({})}
        overlayClassName="z-[110]"
        contentClassName="z-[120]"
      />
    </IntegrationCardShell>
  )
}
