import { useState } from 'react'
import { AlertCircle, CheckCircle2, LoaderCircle, Unlink } from 'lucide-react'
import { MantisBTConnectDialog } from '@/components/mantisbt-connect-dialog'
import { MantisBTIcon } from '@/components/icons/MantisBTIcon'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import {
  getProviderRuntimeContextKey,
  hasRemoteProviderRuntime
} from '@/lib/provider-runtime-context'
import { useAppStore } from '@/store'
import { IntegrationCardDetails, IntegrationCardShell } from './integration-card-shell'
import { useIntegrationSubordinateRowClass } from './integration-card-presentation'
import { getProviderAccountScope } from './provider-account-scope'
import { ProviderHostScopeControl } from './ProviderHostScopeControl'
import { MANTISBT_INTEGRATION_SECTION_ID } from './task-provider-integration-section-ids'
import { translate } from '@/i18n/i18n'

type VerificationResult = { state: 'ok' | 'error'; error?: string }

export function MantisBTIntegrationCard(): React.JSX.Element {
  const mantisBTStatus = useAppStore((s) => s.mantisBTStatus)
  const mantisBTStatusChecked = useAppStore((s) => s.mantisBTStatusChecked)
  const mantisBTStatusContextKey = useAppStore((s) => s.mantisBTStatusContextKey)
  const checkMantisBTConnection = useAppStore((s) => s.checkMantisBTConnection)
  const disconnectMantisBT = useAppStore((s) => s.disconnectMantisBT)
  const testMantisBTConnection = useAppStore((s) => s.testMantisBTConnection)
  const settings = useAppStore((s) => s.settings)
  const mountedRef = useMountedRef()

  const [dialogOpen, setDialogOpen] = useState(false)
  const [testingSiteId, setTestingSiteId] = useState<string | null>(null)
  const [testResultBySite, setTestResultBySite] = useState<Record<string, VerificationResult>>({})

  const contextMatches = mantisBTStatusContextKey === getProviderRuntimeContextKey(settings)
  const checking = !contextMatches || !mantisBTStatusChecked
  const connected = contextMatches && mantisBTStatus.connected
  const sites = mantisBTStatus.sites ?? []
  const siteCount = sites.length || (connected ? 1 : 0)
  const accountScope = getProviderAccountScope(settings)
  const credentialCopy = hasRemoteProviderRuntime(settings)
    ? translate(
        'auto.components.settings.task.tracker.integration.cards.mantisbtRemoteCredentialCopy',
        'Connect a self-hosted MantisBT instance with an API token. Credentials are sent to the selected remote runtime and stored there with runtime-supported encryption.'
      )
    : translate(
        'auto.components.settings.task.tracker.integration.cards.mantisbtLocalCredentialCopy',
        'Connect a self-hosted MantisBT instance with an API token. Credentials are stored locally and encrypted when local runtime storage supports it.'
      )
  const subordinateRowClass = useIntegrationSubordinateRowClass('flex items-center gap-3')
  const accountScopeRowClass = useIntegrationSubordinateRowClass('text-xs')

  const handleDisconnect = async (siteId?: string): Promise<void> => {
    await disconnectMantisBT(siteId)
    if (mountedRef.current) {
      setTestResultBySite({})
    }
  }

  const handleTest = async (siteId: string): Promise<void> => {
    setTestingSiteId(siteId)
    setTestResultBySite((prev) => {
      const next = { ...prev }
      delete next[siteId]
      return next
    })
    const result = await testMantisBTConnection(siteId)
    if (!mountedRef.current) {
      return
    }
    setTestResultBySite((prev) => ({
      ...prev,
      [siteId]: result.ok ? { state: 'ok' } : { state: 'error', error: result.error }
    }))
    setTestingSiteId(null)
  }

  return (
    <IntegrationCardShell
      settingsSectionId={MANTISBT_INTEGRATION_SECTION_ID}
      icon={<MantisBTIcon className="size-5" />}
      name="MantisBT"
      description={
        connected
          ? translate(
              'auto.components.settings.task.tracker.integration.cards.mantisbtSitesConnected',
              '{{value0}} site{{value1}} connected',
              { value0: siteCount, value1: siteCount === 1 ? '' : 's' }
            )
          : checking
            ? translate(
                'auto.components.settings.task.tracker.integration.cards.mantisbtChecking',
                'Checking MantisBT access before showing setup actions.'
              )
            : translate(
                'auto.components.settings.task.tracker.integration.cards.mantisbtDescription',
                'Browse and start work from MantisBT issues.'
              )
      }
      checking={checking}
      statusTone={connected ? 'connected' : 'attention'}
      statusLabel={
        connected
          ? translate(
              'auto.components.settings.mantisbt.integration.card.statusConnected',
              'Connected'
            )
          : translate(
              'auto.components.settings.mantisbt.integration.card.statusNotConnected',
              'Not connected'
            )
      }
      actions={
        !checking ? (
          <Button
            variant={connected ? 'outline' : 'default'}
            size="sm"
            onClick={() => setDialogOpen(true)}
          >
            {connected
              ? translate(
                  'auto.components.settings.task.tracker.integration.cards.mantisbtAddSite',
                  'Add MantisBT site'
                )
              : translate(
                  'auto.components.settings.task.tracker.integration.cards.mantisbtConnect',
                  'Connect MantisBT'
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
          className={accountScopeRowClass}
        />
        {connected && sites.length > 0 ? (
          <div className="space-y-2">
            {sites.map((site) => {
              const testResult = testResultBySite[site.id]
              const testing = testingSiteId === site.id
              return (
                <div key={site.id} className={subordinateRowClass}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {site.displayName}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">{site.siteUrl}</p>
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
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleTest(site.id)}
                    disabled={testing}
                  >
                    {testing ? (
                      <>
                        <LoaderCircle className="size-3.5 mr-1.5 animate-spin" />
                        {translate(
                          'auto.components.settings.task.tracker.integration.cards.3e7c10d286',
                          'Testing...'
                        )}
                      </>
                    ) : (
                      translate(
                        'auto.components.settings.task.tracker.integration.cards.c24e56c532',
                        'Test'
                      )
                    )}
                  </Button>
                  <button
                    onClick={() => void handleDisconnect(site.id)}
                    aria-label={translate(
                      'auto.components.settings.task.tracker.integration.cards.dd3529015d',
                      'Disconnect {{value0}}',
                      { value0: site.displayName }
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
                'auto.components.settings.task.tracker.integration.cards.mantisbtOneTokenPerSite',
                'Each connected MantisBT site has one token stored by the active runtime.'
              )}
            </p>
          </div>
        ) : connected ? (
          <>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.task.tracker.integration.cards.mantisbtConnectedStale',
                'MantisBT is connected for this runtime. Re-check if the connected site list looks stale.'
              )}
            </p>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => void checkMantisBTConnection()}>
                {translate(
                  'auto.components.settings.task.tracker.integration.cards.c90f2ef419',
                  'Re-check'
                )}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void handleDisconnect()}>
                {translate(
                  'auto.components.settings.task.tracker.integration.cards.disconnect_all',
                  'Disconnect'
                )}
              </Button>
            </div>
          </>
        ) : !checking ? (
          <>
            <p className="text-xs text-muted-foreground">{credentialCopy}</p>
            <Button variant="ghost" size="sm" onClick={() => void checkMantisBTConnection()}>
              {translate(
                'auto.components.settings.task.tracker.integration.cards.c90f2ef419',
                'Re-check'
              )}
            </Button>
          </>
        ) : null}
      </IntegrationCardDetails>

      <MantisBTConnectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onConnected={() => setTestResultBySite({})}
        elevated
      />
    </IntegrationCardShell>
  )
}
