import { translate } from '@/i18n/i18n'
import type { CodexCliInstallation } from '../../../../shared/codex-cli-installation'
import { sayAgentSessionFailureTranslated } from './agent-session-failure-words-text'

export function codexMaintenanceLabel(busy = false): string {
  return busy
    ? translate('codex.maintenance.installing', 'Installing…')
    : translate('codex.maintenance.install', 'Install Codex')
}

export function codexMaintenanceReason(installation: CodexCliInstallation): string {
  return sayAgentSessionFailureTranslated(
    installation.status === 'missing' ? 'codexCliMissing' : 'codexCliTooOld',
    { installedVersion: installation.version ?? '', minimumVersion: installation.minimumVersion }
  )
}

export function codexMaintenanceSettingsStatus(installation: CodexCliInstallation): string | null {
  return installation.status === 'missing' || installation.status === 'unsupported'
    ? codexMaintenanceReason(installation)
    : null
}
