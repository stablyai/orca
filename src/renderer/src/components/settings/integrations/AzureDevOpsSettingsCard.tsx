import { getLocalExecutionHostLabel } from '../../../../../shared/execution-host/execution-host'
import { translateLocalExecutionHostLabel } from '@/runtime/hosts/display/execution-host-label'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { AzureDevOpsIntegrationCard } from '../../integrations/source-control/azure-devops-integration-card'
import { useAzureDevOpsHostAuth } from '../../integrations/source-control/use-azure-devops-host-auth'
import { getRemoteAccountsPaneScope } from '../../provider-accounts/provider-account-scope'
import type { SettingsHostScope } from '../host-scope/settings-host-scope'

export function AzureDevOpsSettingsCard({
  hostScope,
  web
}: {
  hostScope: SettingsHostScope
  web: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const environmentId = runtimeTargetEnvironmentId(hostScope.target)
  const environment = useAppStore((s) =>
    web
      ? s.runtimeEnvironments[0]
      : s.runtimeEnvironments.find((entry) => entry.id === environmentId)
  )
  const target = web
    ? environment
      ? { kind: 'environment' as const, environmentId: environment.id }
      : null
    : hostScope.available
      ? hostScope.target
      : null
  const hostLabel =
    web || environmentId
      ? getRemoteAccountsPaneScope(environment?.name ?? null, t).label
      : translateLocalExecutionHostLabel(getLocalExecutionHostLabel())
  const pairingRevision = environment?.pairingRevision ?? environment?.createdAt

  return (
    <HostCard
      key={JSON.stringify([target, pairingRevision])}
      target={target}
      pairingRevision={pairingRevision}
      hostLabel={hostLabel}
    />
  )
}

function HostCard({
  target,
  pairingRevision,
  hostLabel
}: {
  target: Parameters<typeof useAzureDevOpsHostAuth>[0]
  pairingRevision?: number
  hostLabel: string
}): React.JSX.Element {
  const { state, refresh, save } = useAzureDevOpsHostAuth(target, pairingRevision)
  return (
    <AzureDevOpsIntegrationCard
      state={state}
      hostLabel={hostLabel}
      onRefresh={target ? refresh : undefined}
      onSave={(method) => void save(method)}
    />
  )
}
