import { translate } from '../../i18n/i18n'
import type { Translate } from '../../i18n/use-translate'

export type LocalAccountRuntime = {
  runtime: 'host' | 'wsl'
  wslDistro?: string | null
  label: string
}

export function getHostRuntimeLabel(t: Translate = translate): string {
  return navigator.userAgent.includes('Windows')
    ? 'Windows'
    : t('auto.components.settings.AccountsPane.9baf45d071', 'This device')
}

// Standalone runtime labels need sentence casing when interpolated into prose.
export function getRuntimeSentenceLabel(runtime: LocalAccountRuntime): string {
  return runtime.runtime === 'host' && !navigator.userAgent.includes('Windows')
    ? `${runtime.label.charAt(0).toLocaleLowerCase()}${runtime.label.slice(1)}`
    : runtime.label
}
