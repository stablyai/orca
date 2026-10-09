import { useCallback, useEffect, useState } from 'react'
import { Download, History, Upload } from 'lucide-react'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { translate } from '@/i18n/i18n'
import {
  DEFAULT_SETTINGS_BACKUP_SECTIONS,
  SETTINGS_BACKUP_SECTIONS,
  type SettingsBackupSectionId
} from '../../../../shared/settings-backup/settings-backup-catalog'
import type {
  SettingsBackupImportPreview,
  SettingsRecoveryPointSummary
} from '../../../../shared/settings-backup/settings-backup-types'
import { SettingsBackupImportDialog } from './SettingsBackupImportDialog'
import {
  settingsBackupInvalidFileLabel,
  settingsBackupSectionLabel
} from './settings-backup-labels'

type ReadyPreview = Extract<SettingsBackupImportPreview, { status: 'ready' }>
type Status = { tone: 'info' | 'error'; text: string } | null

export function BackupRestorePane(): React.JSX.Element {
  const [sections, setSections] = useState<Set<SettingsBackupSectionId>>(
    () => new Set(DEFAULT_SETTINGS_BACKUP_SECTIONS)
  )
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const [preview, setPreview] = useState<ReadyPreview | null>(null)
  const [recoveryPoints, setRecoveryPoints] = useState<SettingsRecoveryPointSummary[]>([])

  const refreshRecoveryPoints = useCallback(async () => {
    try {
      setRecoveryPoints(await window.api.settings.listRecoveryPoints())
    } catch {
      setRecoveryPoints([])
    }
  }, [])

  useEffect(() => {
    void refreshRecoveryPoints()
  }, [refreshRecoveryPoints])

  const toggleSection = (section: SettingsBackupSectionId, checked: boolean): void => {
    setSections((current) => {
      const next = new Set(current)
      if (checked) {
        next.add(section)
      } else {
        next.delete(section)
      }
      return next
    })
  }

  const runExport = async (): Promise<void> => {
    setBusy(true)
    setStatus(null)
    try {
      const result = await window.api.settings.exportBackup({ sections: [...sections] })
      if (result.status === 'saved') {
        setStatus({
          tone: 'info',
          text:
            result.excludedSecretKeys.length > 0
              ? translate(
                  'auto.components.settings.BackupRestorePane.exportSavedWithExclusions',
                  'Saved {{value0}} settings to {{value1}}. {{value2}} values that looked like credentials were left out.',
                  {
                    value0: result.exportedKeyCount,
                    value1: result.filePath,
                    value2: result.excludedSecretKeys.length
                  }
                )
              : translate(
                  'auto.components.settings.BackupRestorePane.exportSaved',
                  'Saved {{value0}} settings to {{value1}}.',
                  { value0: result.exportedKeyCount, value1: result.filePath }
                )
        })
      } else if (result.status === 'failed') {
        setStatus({ tone: 'error', text: exportFailedText() })
      }
    } catch {
      setStatus({ tone: 'error', text: exportFailedText() })
    } finally {
      setBusy(false)
    }
  }

  const runPreview = async (): Promise<void> => {
    setBusy(true)
    setStatus(null)
    try {
      const result = await window.api.settings.previewBackupImport()
      if (result.status === 'ready') {
        setPreview(result)
      } else if (result.status === 'invalid') {
        setStatus({ tone: 'error', text: settingsBackupInvalidFileLabel(result.reason) })
      }
    } catch {
      setStatus({ tone: 'error', text: settingsBackupInvalidFileLabel('unreadable') })
    } finally {
      setBusy(false)
    }
  }

  const runApply = async (keys: string[]): Promise<void> => {
    if (!preview) {
      return
    }
    setBusy(true)
    try {
      const result = await window.api.settings.applyBackupImport({
        previewId: preview.previewId,
        keys
      })
      setPreview(null)
      if (result.status === 'applied') {
        setStatus({
          tone: 'info',
          text: translate(
            'auto.components.settings.BackupRestorePane.importApplied',
            'Imported {{value0}} settings. A recovery point was saved, so you can undo this below.',
            { value0: result.appliedKeys.length }
          )
        })
      } else if (result.status === 'expired') {
        setStatus({
          tone: 'error',
          text: translate(
            'auto.components.settings.BackupRestorePane.importExpired',
            'This review expired. Import the file again.'
          )
        })
      } else {
        setStatus({
          tone: 'error',
          text: result.rolledBack
            ? translate(
                'auto.components.settings.BackupRestorePane.importRolledBack',
                'The import failed and your previous settings were restored.'
              )
            : translate(
                'auto.components.settings.BackupRestorePane.importFailed',
                'The import failed. Check your settings, or restore a recovery point below.'
              )
        })
      }
    } catch {
      setPreview(null)
      setStatus({
        tone: 'error',
        text: translate(
          'auto.components.settings.BackupRestorePane.importFailed',
          'The import failed. Check your settings, or restore a recovery point below.'
        )
      })
    } finally {
      setBusy(false)
      void refreshRecoveryPoints()
    }
  }

  const runRestore = async (id: string): Promise<void> => {
    setBusy(true)
    setStatus(null)
    try {
      const result = await window.api.settings.restoreRecoveryPoint(id)
      setStatus(
        result.status === 'restored'
          ? {
              tone: 'info',
              text: translate(
                'auto.components.settings.BackupRestorePane.restoreDone',
                'Restored {{value0}} settings.',
                { value0: result.restoredKeys.length }
              )
            }
          : {
              tone: 'error',
              text: translate(
                'auto.components.settings.BackupRestorePane.restoreFailed',
                'The recovery point could not be restored.'
              )
            }
      )
    } catch {
      setStatus({
        tone: 'error',
        text: translate(
          'auto.components.settings.BackupRestorePane.restoreFailed',
          'The recovery point could not be restored.'
        )
      })
    } finally {
      setBusy(false)
      void refreshRecoveryPoints()
    }
  }

  return (
    <div className="divide-y divide-border">
      <section className="space-y-3 py-5">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">
            {translate('auto.components.settings.BackupRestorePane.exportTitle', 'Export settings')}
          </h3>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {translate(
              'auto.components.settings.BackupRestorePane.exportDescription',
              'Save your preferences to a file you can import on another computer. Passwords, API keys, tokens, signed-in accounts and granted permissions are never included.'
            )}
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {SETTINGS_BACKUP_SECTIONS.map((section) => {
            const id = `settings-backup-section-${section}`
            return (
              <div key={section} className="flex items-center gap-2">
                <Checkbox
                  id={id}
                  checked={sections.has(section)}
                  onCheckedChange={(value) => toggleSection(section, value === true)}
                />
                <label htmlFor={id} className="text-xs">
                  {settingsBackupSectionLabel(section)}
                </label>
              </div>
            )
          })}
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || sections.size === 0}
          onClick={() => void runExport()}
        >
          <Download />
          {translate('auto.components.settings.BackupRestorePane.exportButton', 'Export…')}
        </Button>
      </section>

      <section className="space-y-3 py-5">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">
            {translate('auto.components.settings.BackupRestorePane.importTitle', 'Import settings')}
          </h3>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {translate(
              'auto.components.settings.BackupRestorePane.importDescription',
              'Choose a backup file to see what would change. Nothing is applied until you confirm, and a recovery point is saved first.'
            )}
          </p>
        </div>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void runPreview()}>
          <Upload />
          {translate('auto.components.settings.BackupRestorePane.importButton', 'Import…')}
        </Button>
      </section>

      {status?.tone === 'error' ? (
        <p role="alert" className="py-3 text-xs break-all text-destructive">
          {status.text}
        </p>
      ) : null}
      {status?.tone === 'info' ? (
        <p role="status" className="py-3 text-xs break-all text-muted-foreground">
          {status.text}
        </p>
      ) : null}

      <section className="space-y-3 py-5">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">
            {translate(
              'auto.components.settings.BackupRestorePane.recoveryTitle',
              'Recovery points'
            )}
          </h3>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {translate(
              'auto.components.settings.BackupRestorePane.recoveryDescription',
              'Orca keeps the last 10 states from before an import or restore on this computer.'
            )}
          </p>
        </div>
        {recoveryPoints.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.BackupRestorePane.recoveryEmpty',
              'No recovery points yet.'
            )}
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {recoveryPoints.map((point) => (
              <li key={point.id} className="flex items-center gap-3 px-3 py-2">
                <History className="size-4 text-muted-foreground" />
                <div className="min-w-0 flex-1 text-xs">
                  <span className="block">{new Date(point.createdAt).toLocaleString()}</span>
                  <span className="block text-muted-foreground">
                    {point.reason === 'before-import'
                      ? translate(
                          'auto.components.settings.BackupRestorePane.recoveryBeforeImport',
                          'Before import · {{value0}} settings',
                          { value0: point.keyCount }
                        )
                      : translate(
                          'auto.components.settings.BackupRestorePane.recoveryBeforeRestore',
                          'Before restore · {{value0}} settings',
                          { value0: point.keyCount }
                        )}
                  </span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void runRestore(point.id)}
                >
                  {translate('auto.components.settings.BackupRestorePane.restoreButton', 'Restore')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {preview ? (
        <SettingsBackupImportDialog
          preview={preview}
          applying={busy}
          onCancel={() => setPreview(null)}
          onApply={(keys) => void runApply(keys)}
        />
      ) : null}
    </div>
  )
}

function exportFailedText(): string {
  return translate(
    'auto.components.settings.BackupRestorePane.exportFailed',
    'The backup file could not be saved.'
  )
}
