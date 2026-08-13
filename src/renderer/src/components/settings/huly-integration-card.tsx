import { useState } from 'react'
import { AlertCircle, CheckCircle2, ExternalLink, LoaderCircle, Unlink } from 'lucide-react'
import { HulyIcon } from '@/components/icons/HulyIcon'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { useAppStore } from '@/store'
import { IntegrationCardDetails, IntegrationCardShell } from './integration-card-shell'
import { useIntegrationSubordinateRowClass } from './integration-card-presentation'
import { ProviderHostScopeControl } from './ProviderHostScopeControl'
import { getProviderAccountScope } from './provider-account-scope'
import { HULY_INTEGRATION_SECTION_ID } from './task-provider-integration-section-ids'
import { translate } from '@/i18n/i18n'
import { HulyConnectionDialog } from '@/components/huly-connection-dialog'
import { HULY_CLI_INSTALL_COMMAND } from '../../../../shared/agent-feature-install-commands'
import { hasRemoteProviderRuntime } from '@/lib/provider-runtime-context'

type VerificationResult = { state: 'ok' | 'error'; error?: string }

export function HulyIntegrationCard(): React.JSX.Element {
  const hulyStatus = useAppStore((s) => s.hulyStatus)
  const hulyStatusChecked = useAppStore((s) => s.hulyStatusChecked)
  const hulyStatusContextKey = useAppStore((s) => s.hulyStatusContextKey)
  const hulyPreflightStatus = useAppStore((s) => s.hulyPreflightStatus)
  const disconnectHuly = useAppStore((s) => s.disconnectHuly)
  const checkHulyConnection = useAppStore((s) => s.checkHulyConnection)
  const refreshHulyPreflight = useAppStore((s) => s.refreshHulyPreflight)
  const settings = useAppStore((s) => s.settings)
  const mountedRef = useMountedRef()

  const [dialogOpen, setDialogOpen] = useState(false)
  const [testResultByConnection, setTestResultByConnection] = useState<
    Record<string, VerificationResult>
  >({})
  const [verifyingConnectionId, setVerifyingConnectionId] = useState<string | null>(null)

  const contextMatches = hulyStatusContextKey === getProviderRuntimeContextKey(settings)
  const checking = !contextMatches || !hulyStatusChecked
  const connected = contextMatches && hulyStatus.connected === true
  const connections = hulyStatus?.connections ?? []
  const accountScope = getProviderAccountScope(settings)
  const subordinateRowClass = useIntegrationSubordinateRowClass('flex items-center gap-3')
  const isRemote = hasRemoteProviderRuntime(settings)

  // Why: Huly needs the CLI on the same machine Orca runs on. `orca serve` puts
  // Orca on a remote host — the user must install on that host, not their laptop.
  const installHost = isRemote
    ? translate(
        'auto.components.settings.task.tracker.integration.cards.huly_install_host_remote',
        'Orca server'
      )
    : translate(
        'auto.components.settings.task.tracker.integration.cards.huly_install_host_local',
        'this machine'
      )

  const handleDisconnect = async (connectionId?: string): Promise<void> => {
    await disconnectHuly(connectionId ?? null)
    if (mountedRef.current) {
      setTestResultByConnection({})
    }
  }

  const handleVerify = async (connectionId: string): Promise<void> => {
    setVerifyingConnectionId(connectionId)
    try {
      await checkHulyConnection(true)
      if (!mountedRef.current) {
        return
      }
      const status = useAppStore.getState().hulyStatus
      const target = status.connections.find((c) => c.id === connectionId)
      if (!target) {
        setTestResultByConnection((current) => ({
          ...current,
          [connectionId]: {
            state: 'error',
            error: translate(
              'auto.components.settings.task.tracker.integration.cards.huly_verify_connection_missing',
              'Connection not found.'
            )
          }
        }))
        return
      }
      setTestResultByConnection((current) => ({
        ...current,
        [connectionId]: { state: 'ok' }
      }))
    } catch (error) {
      if (!mountedRef.current) {
        return
      }
      setTestResultByConnection((current) => ({
        ...current,
        [connectionId]: {
          state: 'error',
          error:
            error instanceof Error
              ? error.message
              : translate(
                  'auto.components.settings.task.tracker.integration.cards.huly_verify_failed',
                  'Verification failed.'
                )
        }
      }))
    } finally {
      if (mountedRef.current) {
        setVerifyingConnectionId(null)
      }
    }
  }

  return (
    <IntegrationCardShell
      settingsSectionId={HULY_INTEGRATION_SECTION_ID}
      icon={<HulyIcon className="size-5" />}
      name="Huly"
      description={
        connected
          ? translate(
              'auto.components.settings.task.tracker.integration.cards.huly_connected',
              '{{count}} connection configured',
              { count: connections.length }
            )
          : checking
            ? translate(
                'auto.components.settings.task.tracker.integration.cards.huly_checking',
                'Checking Huly access before showing setup actions.'
              )
            : translate(
                'auto.components.settings.task.tracker.integration.cards.huly_setup',
                'Add Huly access to browse and link issues.'
              )
      }
      checking={checking}
      statusTone={connected ? 'connected' : 'attention'}
      statusLabel={
        connected
          ? translate(
              'auto.components.settings.task.tracker.integration.cards.statusConnected',
              'Connected'
            )
          : translate(
              'auto.components.settings.task.tracker.integration.cards.statusNotConnected',
              'Not connected'
            )
      }
      actions={
        !checking ? (
          <Button
            variant={connected ? 'outline' : 'default'}
            size="sm"
            onClick={() => {
              void refreshHulyPreflight()
              setDialogOpen(true)
            }}
          >
            {connected
              ? translate(
                  'auto.components.settings.task.tracker.integration.cards.huly_add_connection',
                  'Add connection'
                )
              : translate(
                  'auto.components.settings.task.tracker.integration.cards.huly_add_access',
                  'Add Huly access'
                )}
          </Button>
        ) : null
      }
    >
      <IntegrationCardDetails>
        <ProviderHostScopeControl
          labelPrefix={translate(
            'auto.components.settings.task.tracker.integration.cards.account_scope_prefix',
            'Account scope'
          )}
          scope={accountScope}
          className={subordinateRowClass}
        />
        <div className="text-xs text-muted-foreground">
          {hulyPreflightStatus?.installed ? (
            <span className="inline-flex items-center gap-1.5 text-status-success">
              <CheckCircle2 className="size-3.5" />
              {translate(
                'auto.components.settings.task.tracker.integration.cards.huly_cli_installed',
                'huly CLI installed{{value0}}',
                {
                  value0: hulyPreflightStatus?.cliVersion
                    ? ` (${hulyPreflightStatus.cliVersion})`
                    : ''
                }
              )}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-status-warning">
              <AlertCircle className="size-3.5" />
              {translate(
                'auto.components.settings.task.tracker.integration.cards.huly_cli_missing',
                'huly CLI not detected on {{value0}}. Run: {{value1}}',
                { value0: installHost, value1: HULY_CLI_INSTALL_COMMAND }
              )}
            </span>
          )}
        </div>
        {connected ? (
          <div className="space-y-2">
            {connections.map((connection) => {
              const testResult = testResultByConnection[connection.id]
              return (
                <div key={connection.id} className={subordinateRowClass}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {connection.name}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {connection.workspace} · {connection.url}
                    </p>
                  </div>
                  {testResult?.state === 'ok' ? (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-status-success">
                      <CheckCircle2 className="size-3.5" />
                      {translate(
                        'auto.components.settings.task.tracker.integration.cards.a2c0015fb8',
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
                  <button
                    type="button"
                    onClick={() => void handleVerify(connection.id)}
                    disabled={verifyingConnectionId === connection.id}
                    aria-label={translate(
                      'auto.components.settings.task.tracker.integration.cards.huly_verify_aria',
                      'Verify {{value0}}',
                      { value0: connection.name }
                    )}
                    className="rounded-md p-1 text-muted-foreground/50 transition-colors hover:text-foreground"
                  >
                    <LoaderCircle
                      className={
                        verifyingConnectionId === connection.id
                          ? 'size-3.5 animate-spin'
                          : 'size-3.5'
                      }
                    />
                  </button>
                  <button
                    onClick={() => void handleDisconnect(connection.id)}
                    aria-label={translate(
                      'auto.components.settings.task.tracker.integration.cards.huly_disconnect_aria',
                      'Disconnect {{value0}}',
                      { value0: connection.name }
                    )}
                    className="rounded-md p-1 text-muted-foreground/50 transition-colors hover:text-destructive"
                  >
                    <Unlink className="size-3.5" />
                  </button>
                </div>
              )
            })}
          </div>
        ) : !checking ? (
          <Button variant="ghost" size="sm" onClick={() => void checkHulyConnection(true)}>
            <LoaderCircle className="size-3.5 mr-1.5" />
            {translate(
              'auto.components.settings.task.tracker.integration.cards.c90f2ef419',
              'Re-check'
            )}
          </Button>
        ) : null}
        <p className="text-[11px] text-muted-foreground/70">
          {translate(
            'auto.components.settings.task.tracker.integration.cards.huly_help',
            'Need help? See the huly-cli documentation.'
          )}
          <a
            href="https://github.com/IamCoder18/huly-cli"
            target="_blank"
            rel="noreferrer"
            className="ml-1 inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="size-3" />
            IamCoder18/huly-cli
          </a>
        </p>
      </IntegrationCardDetails>

      <HulyConnectionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        overlayClassName="z-[110]"
        contentClassName="z-[120]"
      />
    </IntegrationCardShell>
  )
}
