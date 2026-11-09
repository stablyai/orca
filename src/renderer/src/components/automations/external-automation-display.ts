import type { ExternalAutomationManager } from '../../../../shared/automations/external/external-automation'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import {
  formatAutomationDateTime,
  formatAutomationDateTimeWithRelative
} from './automation-page-parts'

export function formatExternalDate(
  value: string | null,
  now: number,
  t?: Translate,
  intlLocale?: string
): string {
  if (!value) {
    return formatAutomationDateTime(null, t, intlLocale)
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) {
    return value
  }
  return formatAutomationDateTimeWithRelative(parsed, now, t, intlLocale)
}

export function getExternalProviderLabel(_manager: ExternalAutomationManager): string {
  return 'OpenClaw'
}

export function getExternalTargetKindLabel(
  manager: ExternalAutomationManager,
  t: Translate = translate
): string {
  return manager.target.type === 'ssh'
    ? t('auto.components.automations.externalDisplay.sshHost', 'SSH host')
    : t('auto.components.automations.externalDisplay.local', 'Local')
}
