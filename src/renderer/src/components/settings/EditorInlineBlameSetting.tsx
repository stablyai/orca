import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { Label } from '../ui/label'
import { SettingsSegmentedControl } from './SettingsFormControls'

type EditorInlineBlameSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function EditorInlineBlameSetting({
  settings,
  updateSettings
}: EditorInlineBlameSettingProps): React.JSX.Element {
  const title = translate(
    'auto.components.settings.GeneralEditorSettingsSection.inlineBlameTitle',
    'Inline Git Blame'
  )
  const description = translate(
    'auto.components.settings.GeneralEditorSettingsSection.inlineBlameDescription',
    'Show who last changed the cursor line at the end of that line.'
  )
  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={['editor', 'git', 'blame', 'author', 'annotation', 'inline', 'line']}
      className="flex items-center justify-between gap-4 py-2"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label>{title}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <SettingsSegmentedControl
        ariaLabel={title}
        value={settings.editorInlineBlameEnabled === false ? 'off' : 'on'}
        onChange={(option) => updateSettings({ editorInlineBlameEnabled: option === 'on' })}
        options={[
          {
            value: 'off',
            label: translate(
              'auto.components.settings.GeneralEditorSettingsSection.bf16ef0af2',
              'Off'
            )
          },
          {
            value: 'on',
            label: translate(
              'auto.components.settings.GeneralEditorSettingsSection.3f6892f307',
              'On'
            )
          }
        ]}
      />
    </SearchableSetting>
  )
}
