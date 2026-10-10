import { useMemo, useState } from 'react'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { translate } from '@/i18n/i18n'
import type {
  SettingsBackupDiffEntry,
  SettingsBackupImportPreview
} from '../../../../shared/settings-backup/settings-backup-types'
import { defaultSelectedSettingsBackupKeys } from '../../../../shared/settings-backup/settings-backup-projection'
import {
  formatSettingsBackupValue,
  settingsBackupKeyLabel,
  settingsBackupSectionLabel,
  settingsBackupSkipReasonLabel
} from './settings-backup-labels'

type ReadyPreview = Extract<SettingsBackupImportPreview, { status: 'ready' }>

type SettingsBackupImportDialogProps = {
  preview: ReadyPreview
  applying: boolean
  onCancel: () => void
  onApply: (keys: string[]) => void
}

export function SettingsBackupImportDialog({
  preview,
  applying,
  onCancel,
  onApply
}: SettingsBackupImportDialogProps): React.JSX.Element {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(defaultSelectedSettingsBackupKeys(preview.entries))
  )
  const applicable = useMemo(
    () => preview.entries.filter((entry) => entry.applicable),
    [preview.entries]
  )
  const blocked = useMemo(
    () => preview.entries.filter((entry) => !entry.applicable),
    [preview.entries]
  )
  const toggle = (key: string, checked: boolean): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (checked) {
        next.add(key)
      } else {
        next.delete(key)
      }
      return next
    })
  }
  const otherPlatform = applicable.some((entry) => entry.skipReason === 'other-platform')

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onCancel())}>
      <DialogContent className="max-w-2xl sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.settings.BackupRestorePane.reviewTitle', 'Review import')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.settings.BackupRestorePane.reviewDescription',
              '{{value0}} · created {{value1}} with Orca {{value2}} on {{value3}}',
              {
                value0: preview.fileName,
                value1: new Date(preview.createdAt).toLocaleString(),
                value2: preview.appVersion,
                value3: preview.sourcePlatform
              }
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="scrollbar-sleek max-h-[50vh] space-y-4 overflow-y-auto pr-1">
          {preview.newerAppVersion ? (
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.BackupRestorePane.newerVersionNotice',
                'This backup came from a newer version of Orca. Settings this version does not know are skipped.'
              )}
            </p>
          ) : null}
          {otherPlatform ? (
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.BackupRestorePane.otherPlatformNotice',
                'Device settings from another operating system are not selected. Paths and shells usually differ between systems.'
              )}
            </p>
          ) : null}

          {applicable.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.BackupRestorePane.nothingToImport',
                'Nothing to import. Your settings already match this backup.'
              )}
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {applicable.map((entry) => (
                <ImportEntryRow
                  key={entry.key}
                  entry={entry}
                  checked={selected.has(entry.key)}
                  onCheckedChange={(checked) => toggle(entry.key, checked)}
                />
              ))}
            </ul>
          )}

          {blocked.length > 0 ? (
            <div className="space-y-1">
              <p className="text-xs font-medium">
                {translate(
                  'auto.components.settings.BackupRestorePane.notImported',
                  'Not imported'
                )}
              </p>
              <ul className="space-y-1">
                {blocked.map((entry) => (
                  <li key={entry.key} className="text-xs text-muted-foreground">
                    <span className="font-mono">{entry.key}</span>
                    {entry.skipReason
                      ? ` — ${settingsBackupSkipReasonLabel(entry.skipReason)}`
                      : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {preview.unchangedKeyCount > 0 ? (
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.BackupRestorePane.unchangedCount',
                '{{value0}} settings already match and are left as they are.',
                { value0: preview.unchangedKeyCount }
              )}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onCancel} disabled={applying}>
            {translate('auto.components.settings.BackupRestorePane.cancel', 'Cancel')}
          </Button>
          <Button
            size="sm"
            disabled={applying || selected.size === 0}
            onClick={() => onApply([...selected])}
          >
            {translate(
              'auto.components.settings.BackupRestorePane.applySelected',
              'Apply {{value0}} selected',
              { value0: selected.size }
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ImportEntryRow({
  entry,
  checked,
  onCheckedChange
}: {
  entry: SettingsBackupDiffEntry
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}): React.JSX.Element {
  const id = `settings-backup-entry-${entry.key}`
  return (
    <li className="flex items-start gap-3 px-3 py-2">
      <Checkbox
        id={id}
        className="mt-0.5"
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <label htmlFor={id} className="min-w-0 flex-1 space-y-0.5">
        <span className="block text-xs font-medium">
          {settingsBackupKeyLabel(entry.key)}
          {entry.section ? (
            <span className="ml-2 font-normal text-muted-foreground">
              {settingsBackupSectionLabel(entry.section)}
            </span>
          ) : null}
        </span>
        <span className="block break-all font-mono text-xs text-muted-foreground">
          {formatSettingsBackupValue(entry.currentValue)} →{' '}
          {formatSettingsBackupValue(entry.incomingValue)}
        </span>
        {entry.skipReason ? (
          <span className="block text-xs text-muted-foreground">
            {settingsBackupSkipReasonLabel(entry.skipReason)}
          </span>
        ) : null}
      </label>
    </li>
  )
}
