import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export const getBackupRestorePaneSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.BackupRestorePane.exportTitle', 'Export settings'),
    description: translate(
      'auto.components.settings.BackupRestorePane.exportSearchDescription',
      'Save your preferences to a file for another computer.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.BackupRestorePane.keywordBackup',
        'backup'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.BackupRestorePane.keywordExport',
        'export'
      ),
      ...translateSearchKeyword('auto.components.settings.BackupRestorePane.keywordSync', 'sync'),
      ...translateSearchKeyword(
        'auto.components.settings.BackupRestorePane.keywordMigrate',
        'new computer'
      )
    ]
  },
  {
    title: translate('auto.components.settings.BackupRestorePane.importTitle', 'Import settings'),
    description: translate(
      'auto.components.settings.BackupRestorePane.importSearchDescription',
      'Review and apply settings from a backup file.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.BackupRestorePane.keywordImport',
        'import'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.BackupRestorePane.keywordRestore',
        'restore'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.BackupRestorePane.keywordBackup',
        'backup'
      )
    ]
  },
  {
    title: translate('auto.components.settings.BackupRestorePane.recoveryTitle', 'Recovery points'),
    description: translate(
      'auto.components.settings.BackupRestorePane.recoverySearchDescription',
      'Undo an import by restoring earlier settings.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.BackupRestorePane.keywordUndo', 'undo'),
      ...translateSearchKeyword(
        'auto.components.settings.BackupRestorePane.keywordRollback',
        'rollback'
      )
    ]
  }
])
