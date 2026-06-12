import type { SettingsImportPreview } from '../../../../shared/settings-portability'
import type { GlobalSettings } from '../../../../shared/types'
import { SETTING_LABELS } from './setting-labels'
import { translate } from '@/i18n/i18n'

type PortableSettingsChangeSummaryProps = {
  preview: SettingsImportPreview
}

/** What a portable settings file would change on this machine: the settings
 *  that differ, whether shortcuts come along, and any skipped keys. */
export function PortableSettingsChangeSummary({
  preview
}: PortableSettingsChangeSummaryProps): React.JSX.Element {
  const changedKeys = preview.changedSettingKeys
  const hasChanges = changedKeys.length > 0 || preview.changedKeybindings

  return (
    <div className="space-y-3">
      {preview.filePath !== undefined && (
        <p className="text-xs text-muted-foreground break-all">
          {translate('auto.components.settings.PortableSettingsChangeSummary.97e44cc133', 'File')}:{' '}
          {preview.filePath}
        </p>
      )}

      {changedKeys.length > 0 && (
        <div>
          <p className="text-xs font-medium mb-1">
            {translate(
              'auto.components.settings.PortableSettingsChangeSummary.1368c68d2e',
              'Settings to update'
            )}{' '}
            ({changedKeys.length})
          </p>
          <ul className="text-xs space-y-1 max-h-40 overflow-y-auto scrollbar-sleek">
            {changedKeys.map((key) => (
              <li key={key} className="text-muted-foreground">
                {SETTING_LABELS[key as keyof GlobalSettings] ?? key}
              </li>
            ))}
          </ul>
        </div>
      )}

      {preview.changedKeybindings && (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.PortableSettingsChangeSummary.2b30a0cec0',
            'Keyboard shortcuts will be replaced with the shortcuts in this file.'
          )}
        </p>
      )}

      {!hasChanges && (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.PortableSettingsChangeSummary.93f591a367',
            'No changes to apply — your current settings already match.'
          )}
        </p>
      )}

      {preview.skippedSettingKeys.length > 0 && (
        <div>
          <p className="text-xs font-medium mb-1">
            {translate(
              'auto.components.settings.PortableSettingsChangeSummary.49ca021159',
              'Settings not imported'
            )}
          </p>
          <p className="text-xs text-muted-foreground mb-1">
            {translate(
              'auto.components.settings.PortableSettingsChangeSummary.c4d57c56aa',
              'These settings are not supported by this version of Orca or are specific to another machine.'
            )}
          </p>
          <ul className="text-xs space-y-1 max-h-24 overflow-y-auto scrollbar-sleek">
            {preview.skippedSettingKeys.map((key) => (
              <li key={key} className="text-muted-foreground">
                {SETTING_LABELS[key as keyof GlobalSettings] ?? key}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
