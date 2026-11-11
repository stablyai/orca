import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { getLocalExecutionHostLabel } from '../../../../shared/execution-host'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { defaultScopeHost } from '@/runtime/hosts/selection/default-creation-host'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

/** Which host a provider card or budget belongs to, and how to change it. */
export type ProviderHostScope = {
  label: string
  description: string
}

function remoteServerScopeLabel(name: string, t: Translate = translate): string {
  return t(
    'auto.components.settings.providerAccountScope.remoteServer',
    'Remote server: {{value0}}',
    { value0: name }
  )
}

function providerHostScopeLabel(target: RuntimeClientTarget, t?: Translate): string {
  return target.kind === 'environment'
    ? remoteServerScopeLabel(target.environmentId, t)
    : getLocalExecutionHostLabel()
}

/** Accounts-pane scope while a remote server owns the roster (#8186). */
export function getRemoteAccountsPaneScope(
  serverName: string | null,
  t: Translate = translate
): ProviderHostScope {
  const name = serverName?.trim()
  return {
    // Unloaded server names need bare fallback labels; interpolation would repeat Remote server.
    label: name
      ? remoteServerScopeLabel(name, t)
      : t('auto.components.settings.AccountsPane.accountScopeRemoteServerUnnamed', 'Remote server'),
    description: t(
      'auto.components.settings.AccountsPane.remoteScopeLocalAccountsKeptHostPicker',
      'Accounts managed on this desktop are unchanged. Choose this computer in the Host menu at the top of Settings to view them.'
    )
  }
}

export function getProviderAccountScope(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  t: Translate = translate
): ProviderHostScope {
  const target = defaultScopeHost(settings)
  return {
    label: providerHostScopeLabel(target, t),
    description:
      target.kind === 'environment'
        ? t(
            'auto.components.settings.providerAccountScope.remoteServerCredentialsNewProjects',
            'Credentials and account checks for this provider are owned by this remote server. To use another host, change Settings > Remote Orca Servers > New projects open on.'
          )
        : t(
            'auto.components.settings.providerAccountScope.localCredentialsNewProjects',
            'Credentials and account checks for this provider are owned by this desktop client. To use a server, change Settings > Remote Orca Servers > New projects open on.'
          )
  }
}

export function getProviderRateLimitScope(
  target: RuntimeClientTarget,
  providerLabel: string,
  t: Translate = translate
): ProviderHostScope {
  return {
    label: providerHostScopeLabel(target, t),
    description:
      target.kind === 'environment'
        ? t(
            'auto.components.settings.providerAccountScope.remoteServerRateLimit',
            '{{value0}} API budget is fetched from the CLI on this remote server. Choose another host in the Host menu at the top of Settings to see its budget.',
            { value0: providerLabel }
          )
        : t(
            'auto.components.settings.providerAccountScope.localRateLimit',
            '{{value0}} API budget is fetched from the CLI on this desktop client. Choose a server in the Host menu at the top of Settings to see its budget.',
            { value0: providerLabel }
          )
  }
}
