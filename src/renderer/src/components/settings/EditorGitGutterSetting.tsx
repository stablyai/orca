import type { GlobalSettings } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { Label } from '../ui/label'
import { SettingsSegmentedControl } from './SettingsFormControls'

type EditorGitGutterSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function EditorGitGutterSetting({
  settings,
  updateSettings
}: EditorGitGutterSettingProps): React.JSX.Element {
  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.EditorGitGutterSetting.0d6a6bc1e3',
        'Git Change Indicators'
      )}
      description={translate(
        'auto.components.settings.EditorGitGutterSetting.68bbcab1b6',
        'Show added, modified, and deleted line markers in the editor gutter, compared against the last commit.'
      )}
      keywords={['editor', 'git', 'gutter', 'diff', 'changes', 'indicators']}
      className="flex items-center justify-between gap-4 py-2"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label>
          {translate(
            'auto.components.settings.EditorGitGutterSetting.0d6a6bc1e3',
            'Git Change Indicators'
          )}
        </Label>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.EditorGitGutterSetting.68bbcab1b6',
            'Show added, modified, and deleted line markers in the editor gutter, compared against the last commit.'
          )}
        </p>
      </div>
      <SettingsSegmentedControl
        ariaLabel={translate(
          'auto.components.settings.EditorGitGutterSetting.0d6a6bc1e3',
          'Git Change Indicators'
        )}
        value={settings.editorGitGutter === false ? 'off' : 'on'}
        onChange={(option) => updateSettings({ editorGitGutter: option === 'on' })}
        options={[
          {
            value: 'off',
            label: translate('auto.components.settings.EditorGitGutterSetting.e65156c441', 'Off')
          },
          {
            value: 'on',
            label: translate('auto.components.settings.EditorGitGutterSetting.ae469f513d', 'On')
          }
        ]}
      />
    </SearchableSetting>
  )
}
