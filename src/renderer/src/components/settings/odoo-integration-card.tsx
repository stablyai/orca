import { useState } from 'react'
import { AlertCircle, CheckCircle2, LoaderCircle, Unlink } from 'lucide-react'
import { toast } from 'sonner'
import { OdooConnectDialog } from '@/components/odoo-connect-dialog'
import { OdooIcon } from '@/components/icons/OdooIcon'
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
import { translate } from '@/i18n/i18n'

type VerificationResult = { state: 'ok' | 'error'; error?: string }

export function OdooIntegrationCard({ className }: { className?: string }): React.JSX.Element {
  const odooStatus = useAppStore((s) => s.odooStatus)
  const odooStatusChecked = useAppStore((s) => s.odooStatusChecked)
  const odooStatusContextKey = useAppStore((s) => s.odooStatusContextKey)
  const checkOdooConnection = useAppStore((s) => s.checkOdooConnection)
  const disconnectOdoo = useAppStore((s) => s.disconnectOdoo)
  const testOdooConnection = useAppStore((s) => s.testOdooConnection)
  const settings = useAppStore((s) => s.settings)
  const mountedRef = useMountedRef()

  const [dialogOpen, setDialogOpen] = useState(false)
  const [testingInstanceId, setTestingInstanceId] = useState<string | null>(null)
  const [testResultByInstance, setTestResultByInstance] = useState<
    Record<string, VerificationResult>
  >({})

  const contextMatches = odooStatusContextKey === getProviderRuntimeContextKey(settings)
  const checking = !contextMatches || !odooStatusChecked
  const connected = contextMatches && odooStatus.connected
  const instances = odooStatus.instances ?? []
  const instanceCount = instances.length || (connected ? 1 : 0)
  const accountScope = getProviderAccountScope(settings)
  const credentialCopy = hasRemoteProviderRuntime(settings)
    ? translate(
        'auto.components.settings.odoo.integration.card.credentialRemote',
        'Connect an Odoo server with its URL, database, login, and API key. Credentials are sent to the selected remote runtime and stored there with runtime-supported encryption.'
      )
    : translate(
        'auto.components.settings.odoo.integration.card.credentialLocal',
        'Connect an Odoo server with its URL, database, login, and API key. Credentials are stored locally and encrypted when local runtime storage supports it.'
      )
  const subordinateRowClass = useIntegrationSubordinateRowClass('flex items-center gap-3')
  const accountScopeRowClass = useIntegrationSubordinateRowClass('text-xs')

  // Why: `disconnectOdoo` rethrows runtime failures, and the click handler
  // discards the promise — without this the user sees nothing at all.
  const handleDisconnect = async (instanceId?: string): Promise<void> => {
    try {
      await disconnectOdoo(instanceId)
    } catch (error) {
      toast.error(
        translate(
          'auto.components.settings.odoo.integration.card.disconnectFailed',
          'Could not disconnect Odoo.'
        ),
        { description: error instanceof Error ? error.message : undefined }
      )
      return
    }
    if (mountedRef.current) {
      setTestResultByInstance({})
    }
  }

  // Why: explicit user-triggered verification. This is the only settings path
  // that decrypts a stored Odoo key, avoiding surprise keychain prompts.
  const handleTest = async (instanceId: string): Promise<void> => {
    setTestingInstanceId(instanceId)
    setTestResultByInstance((prev) => {
      const next = { ...prev }
      delete next[instanceId]
      return next
    })
    const result = await testOdooConnection(instanceId)
    if (!mountedRef.current) {
      return
    }
    setTestResultByInstance((prev) => ({
      ...prev,
      [instanceId]: result.ok ? { state: 'ok' } : { state: 'error', error: result.error }
    }))
    setTestingInstanceId(null)
  }

  return (
    <IntegrationCardShell
      className={className}
      icon={<OdooIcon className="size-5" />}
      name="Odoo"
      description={
        connected
          ? translate(
              'auto.components.settings.odoo.integration.card.connectedSummary',
              '{{value0}} instance{{value1}} connected',
              { value0: instanceCount, value1: instanceCount === 1 ? '' : 's' }
            )
          : checking
            ? translate(
                'auto.components.settings.odoo.integration.card.checking',
                'Checking Odoo access before showing setup actions.'
              )
            : translate(
                'auto.components.settings.odoo.integration.card.tagline',
                'Browse, edit, and comment on Odoo project tasks.'
              )
      }
      checking={checking}
      statusTone={connected ? 'connected' : 'attention'}
      statusLabel={
        connected
          ? translate('auto.components.settings.odoo.integration.card.statusConnected', 'Connected')
          : translate(
              'auto.components.settings.odoo.integration.card.statusNotConnected',
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
                  'auto.components.settings.odoo.integration.card.addInstance',
                  'Add Odoo instance'
                )
              : translate('auto.components.task.page.odoo.panel.d0e1575687', 'Connect Odoo')}
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
        {odooStatus.credentialError ? (
          <p className="flex items-start gap-1.5 text-xs text-destructive">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <span>{odooStatus.credentialError}</span>
          </p>
        ) : null}
        {connected && instances.length > 0 ? (
          <div className="space-y-2">
            {instances.map((instance) => {
              const testResult = testResultByInstance[instance.id]
              const testing = testingInstanceId === instance.id
              return (
                <div key={instance.id} className={subordinateRowClass}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {instance.database}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {instance.serverUrl}
                      {instance.login ? ` · ${instance.login}` : ''}
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
                    onClick={() => void handleTest(instance.id)}
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
                    onClick={() => void handleDisconnect(instance.id)}
                    aria-label={translate(
                      'auto.components.settings.task.tracker.integration.cards.dd3529015d',
                      'Disconnect {{value0}}',
                      { value0: instance.database }
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
                'auto.components.settings.odoo.integration.card.instanceNote',
                'Each connected Odoo instance stores one API key with the active runtime.'
              )}
            </p>
          </div>
        ) : connected ? (
          <>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.odoo.integration.card.connectedNoInstances',
                'Odoo is connected for this runtime. Re-check if the connected instance list looks stale.'
              )}
            </p>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => void checkOdooConnection()}>
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
            <Button variant="ghost" size="sm" onClick={() => void checkOdooConnection()}>
              {translate(
                'auto.components.settings.task.tracker.integration.cards.c90f2ef419',
                'Re-check'
              )}
            </Button>
          </>
        ) : null}
      </IntegrationCardDetails>

      <OdooConnectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onConnected={() => setTestResultByInstance({})}
        overlayClassName="z-[110]"
        contentClassName="z-[120]"
      />
    </IntegrationCardShell>
  )
}
