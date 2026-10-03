import { useState } from 'react'
import { AlertCircle, CheckCircle2, LoaderCircle, Unlink } from 'lucide-react'
import { BusinessmapIcon } from '@/components/icons/BusinessmapIcon'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import {
  getProviderRuntimeContextKey,
  hasRemoteProviderRuntime
} from '@/lib/provider-runtime-context'
import { useAppStore } from '@/store'
import { BusinessmapConnectDialog } from './businessmap-connect-dialog'
import { IntegrationCardDetails, IntegrationCardShell } from './integration-card-shell'
import { useIntegrationSubordinateRowClass } from './integration-card-presentation'
import { getProviderAccountScope } from './provider-account-scope'
import { ProviderHostScopeControl } from './ProviderHostScopeControl'
import { BUSINESSMAP_INTEGRATION_SECTION_ID } from './task-provider-integration-section-ids'
import { translate } from '@/i18n/i18n'

type VerificationResult = { state: 'ok' | 'error'; error?: string }

export function BusinessmapIntegrationCard(): React.JSX.Element {
  const businessmapStatus = useAppStore((s) => s.businessmapStatus)
  const businessmapStatusChecked = useAppStore((s) => s.businessmapStatusChecked)
  const businessmapStatusContextKey = useAppStore((s) => s.businessmapStatusContextKey)
  const checkBusinessmapConnection = useAppStore((s) => s.checkBusinessmapConnection)
  const disconnectBusinessmap = useAppStore((s) => s.disconnectBusinessmap)
  const testBusinessmapConnection = useAppStore((s) => s.testBusinessmapConnection)
  const settings = useAppStore((s) => s.settings)
  const mountedRef = useMountedRef()

  const [dialogOpen, setDialogOpen] = useState(false)
  const [testingSiteId, setTestingSiteId] = useState<string | null>(null)
  const [testResultBySite, setTestResultBySite] = useState<Record<string, VerificationResult>>({})

  const contextMatches = businessmapStatusContextKey === getProviderRuntimeContextKey(settings)
  const checking = !contextMatches || !businessmapStatusChecked
  const connected = contextMatches && businessmapStatus.connected
  const sites = businessmapStatus.sites ?? []
  const siteCount = sites.length || (connected ? 1 : 0)
  const accountScope = getProviderAccountScope(settings)
  const credentialCopy = hasRemoteProviderRuntime(settings)
    ? translate(
        'auto.components.settings.task.tracker.integration.cards.businessmapRemoteCredentials',
        'Connect a Businessmap subdomain with an API key. Credentials are sent to the selected remote runtime and stored there with runtime-supported encryption.'
      )
    : translate(
        'auto.components.settings.task.tracker.integration.cards.businessmapLocalCredentials',
        'Connect a Businessmap subdomain with an API key. Credentials are stored locally and encrypted when local runtime storage supports it.'
      )
  const subordinateRowClass = useIntegrationSubordinateRowClass('flex items-center gap-3')
  const accountScopeRowClass = useIntegrationSubordinateRowClass('text-xs')

  const handleDisconnect = async (siteId?: string): Promise<void> => {
    await disconnectBusinessmap(siteId)
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
    const result = await testBusinessmapConnection(siteId)
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
      settingsSectionId={BUSINESSMAP_INTEGRATION_SECTION_ID}
      icon={<BusinessmapIcon className="size-5" />}
      name="Businessmap"
      description={
        connected
          ? translate(
              'auto.components.settings.task.tracker.integration.cards.businessmapConnected',
              '{{value0}} site{{value1}} connected',
              { value0: siteCount, value1: siteCount === 1 ? '' : 's' }
            )
          : checking
            ? translate(
                'auto.components.settings.task.tracker.integration.cards.businessmapChecking',
                'Checking Businessmap access before showing setup actions.'
              )
            : translate(
                'auto.components.settings.task.tracker.integration.cards.businessmapDescription',
                'Browse, create, and start work from Businessmap cards.'
              )
      }
      checking={checking}
      statusTone={connected ? 'connected' : 'attention'}
      statusLabel={
        connected
          ? translate(
              'auto.components.settings.businessmap.integration.card.statusConnected',
              'Connected'
            )
          : translate(
              'auto.components.settings.businessmap.integration.card.statusNotConnected',
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
                  'auto.components.settings.task.tracker.integration.cards.businessmapAddSite',
                  'Add Businessmap site'
                )
              : translate(
                  'auto.components.settings.task.tracker.integration.cards.businessmapConnect',
                  'Connect Businessmap'
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
              const host = `${site.subdomain}.${site.domain}`
              return (
                <div key={site.id} className={subordinateRowClass}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {site.displayName ?? host}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {host}
                      {site.accountName ? ` · ${site.accountName}` : ''}
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
                      { value0: site.displayName ?? host }
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
                'auto.components.settings.task.tracker.integration.cards.businessmapPerSite',
                'Each connected Businessmap site has one API key stored by the active runtime.'
              )}
            </p>
          </div>
        ) : connected ? (
          <>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.task.tracker.integration.cards.businessmapStale',
                'Businessmap is connected for this runtime. Re-check if the connected site list looks stale.'
              )}
            </p>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => void checkBusinessmapConnection()}>
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
            <Button variant="ghost" size="sm" onClick={() => void checkBusinessmapConnection()}>
              {translate(
                'auto.components.settings.task.tracker.integration.cards.c90f2ef419',
                'Re-check'
              )}
            </Button>
          </>
        ) : null}
      </IntegrationCardDetails>

      <BusinessmapConnectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onConnected={() => setTestResultBySite({})}
      />
    </IntegrationCardShell>
  )
}
