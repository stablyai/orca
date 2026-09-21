import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState,
  CodexSystemDefaultIdentity
} from '../../../../shared/managed-account-types'
import { resolveLocalAccountRuntimeTarget } from '../../../../shared/local-account-runtime'
import { getRendererAppPlatform } from '../../lib/renderer-app-platform'
import { translate } from '@/i18n/i18n'
import type { LocalAccountRuntime } from './accounts-pane-types'

export const EMPTY_WSL_DISTROS: string[] = []

export function getHostRuntimeLabel(): string {
  return navigator.userAgent.includes('Windows')
    ? 'Windows'
    : translate('auto.components.settings.AccountsPane.9baf45d071', 'This device')
}

// Why: the system-default row has no stored identity, so surface the real
// ~/.codex login live — the OAuth email when signed in, a clear custom-provider
// note for env-key logins, and the generic fallback when signed out.
export function getCodexSystemDefaultSubtitle(
  identity: CodexSystemDefaultIdentity | undefined,
  runtimeSentenceLabel: string
): string {
  if (identity?.authKind === 'oauth' && identity.email) {
    return identity.email
  }
  if (identity?.authKind === 'api-key') {
    return translate(
      'auto.components.settings.AccountsPane.codexSystemDefaultCustomProvider',
      'Custom provider — no usage tracked.'
    )
  }
  return translate(
    'auto.components.settings.AccountsPane.fcc4093fc1',
    'Use your current {{value0}} Codex login.',
    { value0: runtimeSentenceLabel }
  )
}

export function getClaudeAccountLabel(
  state: ClaudeRateLimitAccountsState,
  accountId: string | null | undefined
): string {
  if (accountId == null) {
    return 'System default'
  }
  return state.accounts.find((account) => account.id === accountId)?.email ?? 'Claude account'
}

export function getCodexAccountRuntimeLabel(
  account: CodexRateLimitAccountsState['accounts'][number],
  hostLabel = getHostRuntimeLabel()
): string {
  if (account.managedHomeRuntime === 'wsl') {
    return account.wslDistro ? `WSL ${account.wslDistro}` : 'WSL'
  }
  return hostLabel
}

export function getClaudeAccountRuntimeLabel(
  account: ClaudeRateLimitAccountsState['accounts'][number],
  hostLabel = getHostRuntimeLabel()
): string {
  if (account.managedAuthRuntime === 'wsl') {
    return account.wslDistro ? `WSL ${account.wslDistro}` : 'WSL'
  }
  return hostLabel
}

export function getSelectedAccountRuntime(
  settings: GlobalSettings,
  wslSupportedPlatform: boolean,
  wslAvailable: boolean,
  wslDistros: string[],
  wslCapabilitiesLoading: boolean
): LocalAccountRuntime {
  // Why: the two-option control displays the concrete target behind the persisted auto policy.
  const resolvedRuntime = resolveLocalAccountRuntimeTarget(settings, getRendererAppPlatform())
  if (wslSupportedPlatform && resolvedRuntime.runtime === 'wsl') {
    if (!wslAvailable && !wslCapabilitiesLoading) {
      return {
        runtime: 'wsl',
        label: translate('auto.components.settings.AccountsPane.8619f9afa9', 'WSL')
      }
    }
    const configuredDistro = resolvedRuntime.wslDistro?.trim() || null
    const selectedDistro =
      configuredDistro && (wslCapabilitiesLoading || wslDistros.includes(configuredDistro))
        ? configuredDistro
        : null
    return {
      runtime: 'wsl',
      wslDistro: selectedDistro,
      label: selectedDistro
        ? `WSL ${selectedDistro}`
        : translate('auto.components.settings.AccountsPane.2358ac71d2', 'WSL default')
    }
  }
  return { runtime: 'host', label: getHostRuntimeLabel() }
}

export function formatAccountTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}
