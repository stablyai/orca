import { useState } from 'react'
import { CheckCircle2, Loader2, Unlink } from 'lucide-react'
import { ClickUpApiTokenDialog } from '@/components/clickup-api-token-dialog'
import { ClickUpIcon } from '@/components/icons/ClickUpIcon'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { useMountedRef } from '@/hooks/useMountedRef'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { IntegrationCardDetails, IntegrationCardShell } from './integration-card-shell'
import { useIntegrationSubordinateRowClass } from './integration-card-presentation'
import { ProviderHostScopeControl } from './ProviderHostScopeControl'
import { getProviderAccountScope } from './provider-account-scope'
import { translate } from '@/i18n/i18n'

export function ClickUpIntegrationCard(): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const status = useAppStore((state) => state.clickUpStatus) ?? {
    connected: false,
    viewer: null,
    workspaces: []
  }
  const statusChecked = useAppStore((state) => state.clickUpStatusChecked)
  const statusContextKey = useAppStore((state) => state.clickUpStatusContextKey)
  const checkConnection = useAppStore((state) => state.checkClickUpConnection)
  const testConnection = useAppStore((state) => state.testClickUpConnection)
  const disconnect = useAppStore((state) => state.disconnectClickUp)
  const mountedRef = useMountedRef()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [testing, setTesting] = useState(false)
  const [verified, setVerified] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)

  const contextMatches = statusContextKey === getProviderRuntimeContextKey(settings)
  const checking = !contextMatches || !statusChecked
  const connected = contextMatches && status.connected
  const workspaces = status.workspaces ?? []
  const rowClass = useIntegrationSubordinateRowClass('flex items-center gap-3')
  const accountScopeRowClass = useIntegrationSubordinateRowClass('text-xs')

  const handleTest = async (): Promise<void> => {
    setTesting(true)
    setVerified(false)
    setTestError(null)
    const result = await testConnection()
    if (!mountedRef.current) {
      return
    }
    setTesting(false)
    if (result.ok) {
      setVerified(true)
    } else {
      setTestError(result.error)
    }
  }

  const handleDisconnect = async (): Promise<void> => {
    await disconnect()
    if (mountedRef.current) {
      setVerified(false)
      setTestError(null)
    }
  }

  return (
    <IntegrationCardShell
      icon={<ClickUpIcon className="size-5" />}
      name="ClickUp"
      description={
        connected
          ? translate(
              'auto.components.settings.clickup.connectedDescription',
              '{{value0}} Workspace{{value1}} available',
              { value0: workspaces.length, value1: workspaces.length === 1 ? '' : 's' }
            )
          : checking
            ? translate(
                'auto.components.settings.clickup.checkingDescription',
                'Checking ClickUp access before showing setup actions.'
              )
            : translate(
                'auto.components.settings.clickup.disconnectedDescription',
                'Browse, create, update, and link ClickUp tasks.'
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
              ? translate('auto.components.settings.clickup.replaceToken', 'Replace token')
              : translate('auto.components.settings.clickup.connect', 'Connect ClickUp')}
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
          scope={getProviderAccountScope(settings)}
          className={accountScopeRowClass}
        />
        {connected ? (
          <div className="space-y-2">
            <div className={rowClass}>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">
                  {status.viewer?.username ?? 'ClickUp'}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {workspaces.map((workspace) => workspace.name).join(' · ')}
                </p>
              </div>
              {verified ? (
                <span className="flex shrink-0 items-center gap-1 text-xs text-status-success">
                  <CheckCircle2 className="size-3.5" />
                  {translate('auto.components.settings.clickup.verified', 'Verified')}
                </span>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleTest()}
                disabled={testing}
              >
                {testing ? (
                  <>
                    <Loader2 className="animate-spin" />
                    {translate('auto.components.settings.clickup.testing', 'Testing…')}
                  </>
                ) : (
                  translate('auto.components.settings.clickup.test', 'Test')
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => void handleDisconnect()}
                aria-label={translate(
                  'auto.components.settings.clickup.disconnect',
                  'Disconnect ClickUp'
                )}
              >
                <Unlink className="size-3.5" />
              </Button>
            </div>
            {testError ? <p className="text-xs text-destructive">{testError}</p> : null}
            <p className="text-[11px] text-muted-foreground/70">
              {translate(
                'auto.components.settings.clickup.tokenScope',
                'One token grants access to the Workspaces listed above and is stored by the active runtime.'
              )}
            </p>
          </div>
        ) : !checking ? (
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.clickup.setupHelp',
                'Use a Personal API token from ClickUp Settings → Apps.'
              )}
            </p>
            <Button variant="ghost" size="sm" onClick={() => void checkConnection(true)}>
              {translate('auto.components.settings.clickup.recheck', 'Re-check')}
            </Button>
          </div>
        ) : null}
      </IntegrationCardDetails>
      <ClickUpApiTokenDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onConnected={() => {
          setVerified(false)
          setTestError(null)
        }}
      />
    </IntegrationCardShell>
  )
}
