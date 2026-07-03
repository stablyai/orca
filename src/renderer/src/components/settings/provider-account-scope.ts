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
