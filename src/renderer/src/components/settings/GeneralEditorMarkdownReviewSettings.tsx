import type React from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'

type GeneralEditorMarkdownReviewSettingsProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function GeneralEditorMarkdownReviewSettings({
  settings,
  updateSettings
}: GeneralEditorMarkdownReviewSettingsProps): React.JSX.Element {
  return (
    <>
      <SearchableSetting
        title={translate(
          'auto.components.settings.GeneralEditorSettingsSection.4edc104f0f',
          'Markdown Review Notes'
        )}
        description={translate(
          'auto.components.settings.GeneralEditorSettingsSection.5f02e6fb21',
          'Show local markdown review note controls in rich editor mode.'
        )}
        keywords={['markdown', 'review', 'notes', 'annotations', 'agents']}
      >
        <SettingsSwitchRow
          label={translate(
            'auto.components.settings.GeneralEditorSettingsSection.4edc104f0f',
            'Markdown Review Notes'
          )}
          description={translate(
            'auto.components.settings.GeneralEditorSettingsSection.f80603d293',
            'Show local markdown note controls in rich editor mode and agent handoff actions.'
          )}
          checked={settings.markdownReviewToolsEnabled}
          onChange={() =>
            updateSettings({ markdownReviewToolsEnabled: !settings.markdownReviewToolsEnabled })
          }
        />
      </SearchableSetting>

      <SearchableSetting
        title={translate(
          'auto.components.settings.GeneralEditorSettingsSection.fa151d9def',
          'Clear Review Notes After Sending'
        )}
        description={translate(
          'auto.components.settings.GeneralEditorSettingsSection.455658d770',
          'When on, sending review notes to an agent deletes them. Off keeps them as dimmed history you can revisit.'
        )}
        keywords={['markdown', 'review', 'notes', 'history', 'clear', 'send', 'agent']}
      >
        <SettingsSwitchRow
          label={translate(
            'auto.components.settings.GeneralEditorSettingsSection.fa151d9def',
            'Clear Review Notes After Sending'
          )}
          description={translate(
            'auto.components.settings.GeneralEditorSettingsSection.455658d770',
            'When on, sending review notes to an agent deletes them. Off keeps them as dimmed history you can revisit.'
          )}
          checked={settings.clearReviewNotesAfterSend ?? false}
          onChange={() =>
            updateSettings({ clearReviewNotesAfterSend: !settings.clearReviewNotesAfterSend })
          }
        />
      </SearchableSetting>
    </>
  )
}
