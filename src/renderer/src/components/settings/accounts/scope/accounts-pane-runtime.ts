import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState,
  CodexSystemDefaultIdentity
} from '../../../../../../shared/managed-account-types'
import { resolveLocalAccountRuntimeTarget } from '../../../../../../shared/local-account-runtime'
import { getRendererAppPlatform } from '../../../../app-shell/platform/renderer-app-platform'
import { getIntlLocale, translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import {
  type LocalAccountRuntime,
  getHostRuntimeLabel
} from '../../../../lib/provider-accounts/account-runtime-label'

export const EMPTY_WSL_DISTROS: string[] = []

// System default has no saved identity; show live host login or custom-provider detail, falling back when signed out.
export function getCodexSystemDefaultSubtitle(
  identity: CodexSystemDefaultIdentity | undefined,
  runtimeSentenceLabel: string,
  t: Translate = translate
): string {
  if (identity?.authKind === 'oauth' && identity.email) {
    return identity.email
  }
  if (identity?.authKind === 'api-key') {
    return t(
      'auto.components.settings.AccountsPane.codexSystemDefaultCustomProvider',
      'Custom provider — no usage tracked.'
    )
  }
  return t(
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
  wslHostDistro: string | null = null,
  t: Translate = translate
): LocalAccountRuntime {
  // Display the concrete target behind persisted auto policy.
  const resolvedRuntime = wslHostDistro
    ? { runtime: 'wsl' as const, wslDistro: wslHostDistro }
    : resolveLocalAccountRuntimeTarget(settings, getRendererAppPlatform())
  if ((wslSupportedPlatform || wslHostDistro) && resolvedRuntime.runtime === 'wsl') {
    if (!wslHostDistro && !wslAvailable && !wslCapabilitiesLoading) {
      return {
        runtime: 'wsl',
        label: t('auto.components.settings.AccountsPane.8619f9afa9', 'WSL')
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
        : t('auto.components.settings.AccountsPane.2358ac71d2', 'WSL default')
    }
  }
  return { runtime: 'host', label: getHostRuntimeLabel(t) }
}

export function formatAccountTimestamp(
  timestamp: number,
  intlLocale: string = getIntlLocale()
): string {
  return new Date(timestamp).toLocaleString(intlLocale, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}
