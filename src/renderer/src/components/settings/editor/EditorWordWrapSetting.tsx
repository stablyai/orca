import { GENERAL_SETTING_ANCHORS } from '../general/general-setting-anchors'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { useTranslate } from '@/i18n/use-translate'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { Label } from '../../ui/label'
import { SettingsSegmentedControl } from '../form-controls/SettingsFormControls'

type EditorWordWrapSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function EditorWordWrapSetting({
  settings,
  updateSettings
}: EditorWordWrapSettingProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <SearchableSetting
      id={GENERAL_SETTING_ANCHORS.editorWrap}
      title={t(
        'auto.components.settings.GeneralEditorSettingsSection.75e326278e',
        'Editor word wrap'
      )}
      description={t(
        'auto.components.settings.GeneralEditorSettingsSection.9b18de6eea',
        'Wrap long lines in file editors instead of requiring horizontal scrolling.'
      )}
      keywords={['editor', 'code', 'word wrap', 'wrap', 'horizontal scroll', 'long lines']}
      className="flex items-center justify-between gap-4 py-3"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label>
          {t(
            'auto.components.settings.GeneralEditorSettingsSection.75e326278e',
            'Editor word wrap'
          )}
        </Label>
        <p className="text-xs text-muted-foreground">
          {t(
            'auto.components.settings.GeneralEditorSettingsSection.9b18de6eea',
            'Wrap long lines in file editors instead of requiring horizontal scrolling.'
          )}
        </p>
      </div>
      <SettingsSegmentedControl
        ariaLabel={t(
          'auto.components.settings.GeneralEditorSettingsSection.75e326278e',
          'Editor word wrap'
        )}
        value={settings.editorWordWrap === false ? 'off' : 'on'}
        onChange={(option) => updateSettings({ editorWordWrap: option === 'on' })}
        options={[
          {
            value: 'off',
            label: t('auto.components.settings.GeneralEditorSettingsSection.bf16ef0af2', 'Off')
          },
          {
            value: 'on',
            label: t('auto.components.settings.GeneralEditorSettingsSection.3f6892f307', 'On')
          }
        ]}
      />
    </SearchableSetting>
  )
}
