import { useState } from 'react'
import { CheckCircle2, LoaderCircle, Unlink } from 'lucide-react'
import { VoloConnectDialog } from '@/components/volo-connect-dialog'
import { VoloIcon } from '@/components/icons/VoloIcon'
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
import { VOLO_INTEGRATION_SECTION_ID } from './task-provider-integration-section-ids'
import { translate } from '@/i18n/i18n'

export function VoloIntegrationCard(): React.JSX.Element {
  const voloStatus = useAppStore((s) => s.voloStatus)
  const voloStatusChecked = useAppStore((s) => s.voloStatusChecked)
  const voloStatusContextKey = useAppStore((s) => s.voloStatusContextKey)
  const checkVoloConnection = useAppStore((s) => s.checkVoloConnection)
  const disconnectVolo = useAppStore((s) => s.disconnectVolo)
  const testVoloConnection = useAppStore((s) => s.testVoloConnection)
  const settings = useAppStore((s) => s.settings)
  const mountedRef = useMountedRef()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testOk, setTestOk] = useState<boolean | null>(null)

  const contextMatches = voloStatusContextKey === getProviderRuntimeContextKey(settings)
  const checking = !contextMatches || !voloStatusChecked
  const connected = contextMatches && voloStatus.connected
  const accountScope = getProviderAccountScope(settings)
  const subordinateRowClass = useIntegrationSubordinateRowClass('flex items-center gap-3')
  const accountScopeRowClass = useIntegrationSubordinateRowClass('text-xs')
  const credentialCopy = hasRemoteProviderRuntime(settings)
    ? translate(
        'auto.components.settings.volo.integration.remote',
        'Sign in to Volo with Google. The session is sent to the selected remote runtime and stored there with runtime-supported encryption.'
      )
    : translate(
        'auto.components.settings.volo.integration.local',
        'Sign in to Volo with Google — the same login as the Volo app. The session is stored locally and encrypted when local runtime storage supports it.'
      )

  const handleTest = async (): Promise<void> => {
    setTesting(true)
    setTestOk(null)
    const result = await testVoloConnection()
    if (!mountedRef.current) {
      return
    }
    setTestOk(result.ok)
    setTesting(false)
  }

  return (
    <IntegrationCardShell
      settingsSectionId={VOLO_INTEGRATION_SECTION_ID}
      icon={<VoloIcon className="size-5" />}
      name="Volo"
      description={
        connected
          ? voloStatus.viewer?.displayName ||
            translate('auto.components.settings.volo.integration.connected', 'Volo connected')
          : checking
            ? translate(
                'auto.components.settings.volo.integration.checking',
                'Checking Volo access before showing setup actions.'
              )
            : translate(
                'auto.components.settings.volo.integration.idle',
                'Browse Volo boards and start workspaces from tasks.'
              )
      }
      checking={checking}
      statusTone={connected ? 'connected' : 'attention'}
      statusLabel={
        connected
          ? translate('auto.components.settings.volo.integration.statusConnected', 'Connected')
          : translate(
              'auto.components.settings.volo.integration.statusNotConnected',
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
              ? translate('auto.components.settings.volo.integration.update', 'Sign in again')
              : translate('auto.components.settings.volo.integration.connect', 'Connect Volo')}
          </Button>
        ) : null
      }
    >
      <IntegrationCardDetails>
        <p className="text-xs text-muted-foreground">{credentialCopy}</p>
        {connected ? (
          <div className={subordinateRowClass}>
            <Button variant="ghost" size="sm" onClick={() => void handleTest()} disabled={testing}>
              {testing ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
              {translate('auto.components.settings.volo.integration.test', 'Test')}
            </Button>
            {testOk === true ? <CheckCircle2 className="size-3.5 text-muted-foreground" /> : null}
            <Button variant="ghost" size="sm" onClick={() => void disconnectVolo()}>
              <Unlink className="size-3.5" />
              {translate('auto.components.settings.volo.integration.disconnect', 'Disconnect')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void checkVoloConnection()}>
              {translate('auto.components.settings.volo.integration.refresh', 'Refresh')}
            </Button>
          </div>
        ) : null}
        <div className={accountScopeRowClass}>
          <ProviderHostScopeControl labelPrefix="Volo" scope={accountScope} />
        </div>
      </IntegrationCardDetails>
      <VoloConnectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onConnected={() => void checkVoloConnection()}
      />
    </IntegrationCardShell>
  )
}
