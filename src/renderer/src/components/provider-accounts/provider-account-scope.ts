import { translate } from '@/i18n/i18n'
import { getLocalExecutionHostLabel } from '../../../../shared/execution-host'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { defaultScopeHost } from '@/lib/default-creation-host'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

/** Which host a provider card or budget belongs to, and how to change it. */
export type ProviderHostScope = {
  label: string
  description: string
}

function remoteServerScopeLabel(name: string): string {
  return translate(
    'auto.components.settings.providerAccountScope.remoteServer',
    'Remote server: {{value0}}',
    { value0: name }
  )
}

function providerHostScopeLabel(target: RuntimeClientTarget): string {
  return target.kind === 'environment'
    ? remoteServerScopeLabel(target.environmentId)
    : getLocalExecutionHostLabel()
}

/** Accounts-pane scope while a remote server owns the roster (#8186). */
export function getRemoteAccountsPaneScope(serverName: string | null): ProviderHostScope {
  const name = serverName?.trim()
  return {
    // Unloaded server names need bare fallback labels; interpolation would repeat Remote server.
    label: name
      ? remoteServerScopeLabel(name)
      : translate(
          'auto.components.settings.AccountsPane.accountScopeRemoteServerUnnamed',
          'Remote server'
        ),
    description: translate(
      'auto.components.settings.AccountsPane.remoteScopeLocalAccountsKeptHostPicker',
      'Accounts managed on this desktop are unchanged. Choose this computer in the Host menu at the top of Settings to view them.'
    )
  }
}

export function getProviderAccountScope(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): ProviderHostScope {
  const target = defaultScopeHost(settings)
  return {
    label: providerHostScopeLabel(target),
    description:
      target.kind === 'environment'
        ? translate(
            'auto.components.settings.providerAccountScope.remoteServerCredentialsNewProjects',
            'Credentials and account checks for this provider are owned by this remote server. To use another host, change Settings > Remote Orca Servers > New projects open on.'
          )
        : translate(
            'auto.components.settings.providerAccountScope.localCredentialsNewProjects',
            'Credentials and account checks for this provider are owned by this desktop client. To use a server, change Settings > Remote Orca Servers > New projects open on.'
          )
  }
}

export function getProviderRateLimitScope(
  target: RuntimeClientTarget,
  providerLabel: string
): ProviderHostScope {
  return {
    label: providerHostScopeLabel(target),
    description:
      target.kind === 'environment'
        ? translate(
            'auto.components.settings.providerAccountScope.remoteServerRateLimit',
            '{{value0}} API budget is fetched from the CLI on this remote server. Choose another host in the Host menu at the top of Settings to see its budget.',
            { value0: providerLabel }
          )
        : translate(
            'auto.components.settings.providerAccountScope.localRateLimit',
            '{{value0}} API budget is fetched from the CLI on this desktop client. Choose a server in the Host menu at the top of Settings to see its budget.',
            { value0: providerLabel }
          )
  }
}
