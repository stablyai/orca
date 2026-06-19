import { useState } from 'react'
import { AlertCircle, CheckCircle2, LoaderCircle, Unlink } from 'lucide-react'
import { GiteaConnectDialog } from '@/components/gitea-connect-dialog'
import { GiteaIcon } from '@/components/icons/GiteaIcon'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store'
import { IntegrationCardDetails, IntegrationCardShell } from './integration-card-shell'
import { translate } from '@/i18n/i18n'

type VerificationResult = { state: 'ok' | 'error'; error?: string }

export function GiteaTaskIntegrationCard(): React.JSX.Element {
  const giteaStatus = useAppStore((s) => s.giteaStatus)
  const giteaStatusLoaded = useAppStore((s) => s.giteaStatusLoaded)
  const refreshGiteaStatus = useAppStore((s) => s.refreshGiteaStatus)
  const giteaDisconnect = useAppStore((s) => s.giteaDisconnect)
  const giteaTestConnection = useAppStore((s) => s.giteaTestConnection)
  const mountedRef = useMountedRef()

  const [dialogOpen, setDialogOpen] = useState(false)
  const [testingServerId, setTestingServerId] = useState<string | null>(null)
  const [testResultByServer, setTestResultByServer] = useState<Record<string, VerificationResult>>(
    {}
  )

  const checking = !giteaStatusLoaded
  const connected = giteaStatus?.connected === true
  const servers = giteaStatus?.servers ?? []
  const serverCount = servers.length || (connected ? 1 : 0)

  const handleDisconnect = async (serverId?: string): Promise<void> => {
    try {
      await giteaDisconnect(serverId)
    } finally {
      // Why: clear results even if disconnect rejects, so the UI isn't left stale.
      if (mountedRef.current) {
        setTestResultByServer({})
      }
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
      const result = await giteaTestConnection(serverId)
      if (!mountedRef.current) {
        return
      }
      setTestResultByServer((prev) => ({
        ...prev,
        [serverId]: result.ok ? { state: 'ok' } : { state: 'error', error: result.error }
      }))
    } catch (error) {
      if (!mountedRef.current) {
        return
      }
      setTestResultByServer((prev) => ({
        ...prev,
        [serverId]: {
          state: 'error',
          error:
            error instanceof Error
              ? error.message
              : translate(
                  'auto.components.settings.gitea.integration.card.d4e5f6a7b8',
                  'Connection failed.'
                )
        }
      }))
    } finally {
      // Why: always clear the per-server spinner, even on rejection.
      if (mountedRef.current) {
        setTestingServerId(null)
      }
    }
  }

  return (
    <IntegrationCardShell
      icon={<GiteaIcon className="size-5" />}
      name="Gitea"
      description={
        connected
          ? translate(
              'auto.components.settings.gitea.integration.card.069f07af1c',
              '{{value0}} server{{value1}} connected',
              { value0: serverCount, value1: serverCount === 1 ? '' : 's' }
            )
          : checking
            ? translate(
                'auto.components.settings.gitea.integration.card.31b7f980fb',
                'Checking Gitea access before showing setup actions.'
              )
            : translate(
                'auto.components.settings.gitea.integration.card.5a8cd33300',
                'Browse, create, and start work from Gitea issues.'
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
              ? translate(
                  'auto.components.settings.gitea.integration.card.bdcb1e773f',
                  'Add server'
                )
              : translate(
                  'auto.components.settings.gitea.integration.card.9ce5f12a0d',
                  'Connect Gitea'
                )}
          </Button>
        ) : null
      }
    >
      {giteaStatus?.credentialError ? (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-destructive">
          <AlertCircle className="size-3.5 shrink-0" />
          {giteaStatus.credentialError}
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
                      'auto.components.settings.gitea.integration.card.3852b1fd6f',
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
                        'auto.components.settings.gitea.integration.card.09bde44485',
                        'Testing...'
                      )}
                    </>
                  ) : (
                    translate('auto.components.settings.gitea.integration.card.2bf28d5929', 'Test')
                  )}
                </Button>
                <button
                  onClick={() => void handleDisconnect(server.id)}
                  aria-label={translate(
                    'auto.components.settings.gitea.integration.card.d0b31b4845',
                    'Disconnect {{value0}}',
                    { value0: server.displayName }
                  )}
                  className="rounded-md p-1 text-muted-foreground/50 transition-colors hover:text-destructive"
                >
                  <Unlink className="size-3.5" />
                </button>
              </div>
            )
          })}
          <p className="text-[11px] text-muted-foreground/70">
            {translate(
              'auto.components.settings.gitea.integration.card.f47924e554',
              'Each connected Gitea server stores one token, encrypted locally.'
            )}
          </p>
        </div>
      ) : !checking && !connected ? (
        <IntegrationCardDetails>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.gitea.integration.card.c043731756',
              'Connect a self-hosted Gitea server with its URL and a personal access token. Credentials are stored locally and encrypted when local runtime storage supports it.'
            )}
          </p>
          <Button variant="ghost" size="sm" onClick={() => void refreshGiteaStatus()}>
            {translate('auto.components.settings.gitea.integration.card.9a555db81e', 'Re-check')}
          </Button>
        </IntegrationCardDetails>
      ) : null}

      <GiteaConnectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onConnected={() => setTestResultByServer({})}
        overlayClassName="z-[110]"
        contentClassName="z-[120]"
      />
    </IntegrationCardShell>
  )
}
