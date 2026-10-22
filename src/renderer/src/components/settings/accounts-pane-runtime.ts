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
  wslCapabilitiesLoading: boolean,
  /** A WSL host's distro: its accounts are this desktop's for that distro, with no location to pick. */
  wslHostDistro: string | null = null
): LocalAccountRuntime {
  // Why: the two-option control displays the concrete target behind the persisted auto policy.
  const resolvedRuntime = wslHostDistro
    ? { runtime: 'wsl' as const, wslDistro: wslHostDistro }
    : resolveLocalAccountRuntimeTarget(settings, getRendererAppPlatform())
  if ((wslSupportedPlatform || wslHostDistro) && resolvedRuntime.runtime === 'wsl') {
    if (!wslHostDistro && !wslAvailable && !wslCapabilitiesLoading) {
      return {
        runtime: 'wsl',
        label: translate('auto.components.settings.AccountsPane.8619f9afa9', 'WSL')
      }
    }
    const configuredDistro = resolvedRuntime.wslDistro?.trim() || null
    const selectedDistro =
      wslHostDistro ??
      (configuredDistro && (wslCapabilitiesLoading || wslDistros.includes(configuredDistro))
        ? configuredDistro
        : null)
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

// Why: host runtime labels are standalone UI labels; interpolated prose needs sentence casing.
export function getRuntimeSentenceLabel(runtime: LocalAccountRuntime): string {
  return runtime.runtime === 'host' && !navigator.userAgent.includes('Windows')
    ? `${runtime.label.charAt(0).toLocaleLowerCase()}${runtime.label.slice(1)}`
    : runtime.label
}

export function formatAccountTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}
