import { translate } from '@/i18n/i18n'
import { getLocalExecutionHostLabel } from '../../../../shared/execution-host'
import type { GlobalSettings } from '../../../../shared/types'

export type ProviderAccountScope = {
  label: string
  description: string
}

export type ProviderRateLimitScope = {
  label: string
  description: string
}

/** Accounts-pane scope while a remote server owns the roster (#8186). */
export function getRemoteAccountsPaneScope(serverName: string | null): ProviderAccountScope {
  const name = serverName?.trim()
  return {
    // Why: the saved-server list is still empty on first paint, and the generic
    // fallback is already a noun phrase — interpolating it would render
    // "Remote server: the remote server".
    label: name
      ? translate(
          'auto.components.settings.providerAccountScope.remoteServer',
          'Remote server: {{value0}}',
          { value0: name }
        )
      : translate(
          'auto.components.settings.AccountsPane.accountScopeRemoteServerUnnamed',
          'Remote server'
        ),
    description: translate(
      'auto.components.settings.AccountsPane.remoteScopeLocalAccountsKept',
      'Accounts managed on this desktop are unchanged. Switch the default runtime back to Local desktop to view them.'
    )
  }
}

export function getProviderAccountScope(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): ProviderAccountScope {
  const runtimeId = settings?.activeRuntimeEnvironmentId?.trim()
  if (runtimeId) {
    return {
      label: translate(
        'auto.components.settings.providerAccountScope.remoteServer',
        'Remote server: {{value0}}',
        { value0: runtimeId }
      ),
      description: translate(
        'auto.components.settings.providerAccountScope.remoteServerCredentials',
        'Credentials and account checks for this provider are owned by this remote server. Use Settings > Remote Orca Servers > Advanced to edit another default runtime scope.'
      )
    }
  }
  return {
    label: getLocalExecutionHostLabel(),
    description: translate(
      'auto.components.settings.providerAccountScope.localCredentials',
      'Credentials and account checks for this provider are owned by this desktop client. Use Settings > Remote Orca Servers > Advanced to edit server-owned credentials.'
    )
  }
}

export function getProviderRateLimitScope(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  providerLabel: string
): ProviderRateLimitScope {
  const runtimeId = settings?.activeRuntimeEnvironmentId?.trim()
  if (runtimeId) {
    return {
      label: translate(
        'auto.components.settings.providerAccountScope.remoteServer',
        'Remote server: {{value0}}',
        { value0: runtimeId }
      ),
      description: translate(
        'auto.components.settings.providerAccountScope.remoteServerRateLimit',
        '{{value0}} API budget is fetched from the CLI on this remote server. Use Settings > Remote Orca Servers > Advanced to view another default runtime budget.',
        { value0: providerLabel }
      )
    }
  }
  return {
    label: getLocalExecutionHostLabel(),
    description: translate(
      'auto.components.settings.providerAccountScope.localRateLimit',
      '{{value0}} API budget is fetched from the CLI on this desktop client. Use Settings > Remote Orca Servers > Advanced to view server-owned budgets.',
      { value0: providerLabel }
    )
  }
}
