import { translate } from '@/i18n/i18n'
import type { SettingsBackupSectionId } from '../../../../shared/settings-backup/settings-backup-catalog'
import type {
  SettingsBackupInvalidReason,
  SettingsBackupSkipReason
} from '../../../../shared/settings-backup/settings-backup-types'
import { SETTING_LABELS } from './setting-labels'

export function settingsBackupSectionLabel(section: SettingsBackupSectionId): string {
  switch (section) {
    case 'appearance':
      return translate('auto.components.settings.BackupRestorePane.sectionAppearance', 'Appearance')
    case 'terminal':
      return translate('auto.components.settings.BackupRestorePane.sectionTerminal', 'Terminal')
    case 'editor':
      return translate('auto.components.settings.BackupRestorePane.sectionEditor', 'Editor & files')
    case 'git':
      return translate(
        'auto.components.settings.BackupRestorePane.sectionGit',
        'Git & source control'
      )
    case 'agents':
      return translate('auto.components.settings.BackupRestorePane.sectionAgents', 'Agents & AI')
    case 'browser':
      return translate('auto.components.settings.BackupRestorePane.sectionBrowser', 'Browser')
    case 'notifications':
      return translate(
        'auto.components.settings.BackupRestorePane.sectionNotifications',
        'Notifications'
      )
    case 'general':
      return translate('auto.components.settings.BackupRestorePane.sectionGeneral', 'General')
    case 'experimental':
      return translate(
        'auto.components.settings.BackupRestorePane.sectionExperimental',
        'Experimental features'
      )
    case 'device':
      return translate(
        'auto.components.settings.BackupRestorePane.sectionDevice',
        'This device (paths, shells, runtimes)'
      )
  }
}

export function settingsBackupSkipReasonLabel(reason: SettingsBackupSkipReason): string {
  switch (reason) {
    case 'other-platform':
      return translate(
        'auto.components.settings.BackupRestorePane.skipOtherPlatform',
        'Made on another operating system; check before applying'
      )
    case 'secret-like-value':
      return translate(
        'auto.components.settings.BackupRestorePane.skipSecret',
        'Looks like a credential, so it is never imported'
      )
    case 'unsupported-key':
      return translate(
        'auto.components.settings.BackupRestorePane.skipUnsupported',
        'Not supported by this version of Orca'
      )
    case 'protected-key':
      return translate(
        'auto.components.settings.BackupRestorePane.skipProtected',
        'Accounts, secrets and permissions must be set up on each device'
      )
    case 'invalid-value':
      return translate(
        'auto.components.settings.BackupRestorePane.skipInvalid',
        'The value in the backup is not valid for this setting'
      )
  }
}

export function settingsBackupInvalidFileLabel(reason: SettingsBackupInvalidReason): string {
  switch (reason) {
    case 'unreadable':
      return translate(
        'auto.components.settings.BackupRestorePane.invalidUnreadable',
        'The file could not be read.'
      )
    case 'too-large':
      return translate(
        'auto.components.settings.BackupRestorePane.invalidTooLarge',
        'The file is too large to be an Orca settings backup.'
      )
    case 'not-json':
    case 'wrong-format':
      return translate(
        'auto.components.settings.BackupRestorePane.invalidFormat',
        'The file is not an Orca settings backup.'
      )
    case 'newer-format':
      return translate(
        'auto.components.settings.BackupRestorePane.invalidNewer',
        'The backup was made by a newer version of Orca. Update Orca and try again.'
      )
    case 'integrity-mismatch':
      return translate(
        'auto.components.settings.BackupRestorePane.invalidIntegrity',
        'The backup is damaged or was edited after it was created. Your settings were not changed.'
      )
  }
}

export function settingsBackupKeyLabel(key: string): string {
  const label = Object.entries(SETTING_LABELS).find(([candidate]) => candidate === key)?.[1]
  return label ?? key
}

export function formatSettingsBackupValue(value: unknown): string {
  if (value === undefined) {
    return '—'
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 80 ? `${text.slice(0, 77)}…` : text
}
