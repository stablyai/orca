import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { isEditorTextDirection } from '../../../../shared/editor-text-direction'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { Label } from '../ui/label'
import { SettingsSegmentedControl } from './SettingsFormControls'

type EditorTextDirectionSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function EditorTextDirectionSetting({
  settings,
  updateSettings
}: EditorTextDirectionSettingProps): React.JSX.Element {
  const title = translate(
    'auto.components.settings.EditorTextDirectionSetting.3e9a5c3a6f',
    'Editor Text Direction'
  )
  const description = translate(
    'auto.components.settings.EditorTextDirectionSetting.dc19442703',
    'Base document direction in file editors. Auto picks a direction per line from its first strong character.'
  )
  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={[
        'editor',
        'rtl',
        'ltr',
        'right to left',
        'direction',
        'bidi',
        'hebrew',
        'arabic',
        'persian'
      ]}
      className="flex items-center justify-between gap-4 py-2"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label>{title}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <SettingsSegmentedControl
        ariaLabel={title}
        value={
          isEditorTextDirection(settings.editorTextDirection) ? settings.editorTextDirection : 'ltr'
        }
        onChange={(option) => {
          if (isEditorTextDirection(option)) {
            updateSettings({ editorTextDirection: option })
          }
        }}
        options={[
          {
            value: 'ltr',
            label: translate(
              'auto.components.settings.EditorTextDirectionSetting.c5017d2c6d',
              'LTR'
            )
          },
          {
            value: 'auto',
            label: translate(
              'auto.components.settings.EditorTextDirectionSetting.66496ceba1',
              'Auto'
            )
          },
          {
            value: 'rtl',
            label: translate(
              'auto.components.settings.EditorTextDirectionSetting.6b45892278',
              'RTL'
            )
          }
        ]}
      />
    </SearchableSetting>
  )
}
