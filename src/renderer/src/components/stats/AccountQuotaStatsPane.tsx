import type { ComponentType } from 'react'
import { StatsPane } from './StatsPane'
import { useAppStore } from '../../store'
import { translate } from '@/i18n/i18n'
import type { SettingsHostScope } from '../settings/settings-host-scope'
import { SettingsHostScopeUnavailableNotice } from '../settings/SettingsHostScopePicker'
import { resolveAccountOwner } from '@/lib/wsl-host-account-owner'
import { isWebClientLocation } from '@/lib/web-client-location'
import {
  getUsageOwnerHostScope,
  useOwnerUsageRateLimits
} from '../status-bar/use-owner-usage-rate-limits'
import { UsageAccountQuotas } from './UsageAccountQuotas'

const HistoryPane: ComponentType<{ hostScope?: SettingsHostScope }> = StatsPane

export function AccountQuotaStatsPane({
  hostScope
}: {
  hostScope?: SettingsHostScope
}): React.JSX.Element {
  return hostScope?.available === false ? (
    <SettingsHostScopeUnavailableNotice />
  ) : (
    <OwnedAccountQuotas hostScope={hostScope} />
  )
}
function OwnedAccountQuotas({ hostScope }: { hostScope?: SettingsHostScope }): React.JSX.Element {
  const localRateLimits = useAppStore((state) => state.rateLimits)
  const refreshRateLimits = useAppStore((state) => state.refreshRateLimits)
  const fetchInactiveClaude = useAppStore((state) => state.fetchInactiveClaudeAccountUsage)
  const fetchInactiveCodex = useAppStore((state) => state.fetchInactiveCodexAccountUsage)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const environments = useAppStore((state) => state.runtimeEnvironments)
  const selectedHost =
    hostScope?.target.kind === 'local' && isWebClientLocation() && environments?.length === 1
      ? { kind: 'environment' as const, environmentId: environments[0].id }
      : hostScope?.target
  const accountTarget = selectedHost
    ? resolveAccountOwner(selectedHost, environments ?? []).target
    : undefined
  const { rateLimits, remoteOwner, refreshRemote, accounts, accountsUnverifiable } =
    useOwnerUsageRateLimits(localRateLimits, accountTarget, true)
  return (
    <div className="@container space-y-5">
      <UsageAccountQuotas
        rateLimits={rateLimits}
        accounts={accounts}
        accountsUnverifiable={accountsUnverifiable}
        localOwner={remoteOwner === null}
        ownerLabel={remoteOwner?.label ?? translate('stats.usage.localHost', 'This device')}
        onRefresh={
          refreshRemote ??
          (async () => {
            await refreshRateLimits()
            await Promise.all([fetchInactiveClaude(), fetchInactiveCodex()])
          })
        }
        onManage={() => {
          openSettingsTarget({
            pane: 'accounts',
            repoId: null,
            hostScope: getUsageOwnerHostScope(remoteOwner)
          })
          openSettingsPage()
        }}
      />
      <HistoryPane hostScope={hostScope} />
    </div>
  )
}
