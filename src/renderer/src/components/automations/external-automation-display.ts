import type { ExternalAutomationManager } from '../../../../shared/automations-types'
import { formatAutomationDateTimeWithRelative } from './automation-page-parts'

export function formatExternalDate(value: string | null, now: number): string {
  if (!value) {
    return 'Never'
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) {
    return value
  }
  return formatAutomationDateTimeWithRelative(parsed, now)
}

export function getExternalProviderLabel(_manager: ExternalAutomationManager): string {
  return 'OpenClaw'
}

export function getExternalTargetKindLabel(manager: ExternalAutomationManager): string {
  return manager.target.type === 'ssh' ? 'SSH host' : 'Local'
}
