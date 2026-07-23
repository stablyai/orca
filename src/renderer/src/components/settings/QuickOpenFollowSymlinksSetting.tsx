import type { GlobalSettings } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { Label } from '../ui/label'
import { SettingsSegmentedControl } from './SettingsFormControls'

type QuickOpenFollowSymlinksSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

const TITLE_KEY =
  'auto.components.settings.GeneralEditorSettingsSection.quickOpenFollowSymlinksTitle'
const TITLE_FALLBACK = 'Quick Open Follows Symlinks'
const DESCRIPTION_KEY =
  'auto.components.settings.GeneralEditorSettingsSection.quickOpenFollowSymlinksDescription'
const DESCRIPTION_FALLBACK =
  'Include files inside symlinked directories in Quick Open (Cmd/Ctrl+P). Off by default because following symlinks can reach content outside the workspace.'

export function QuickOpenFollowSymlinksSetting({
  settings,
  updateSettings
}: QuickOpenFollowSymlinksSettingProps): React.JSX.Element {
  return (
    <SearchableSetting
      title={translate(TITLE_KEY, TITLE_FALLBACK)}
      description={translate(DESCRIPTION_KEY, DESCRIPTION_FALLBACK)}
      keywords={[
        'quick open',
        'cmd+p',
        'ctrl+p',
        'symlink',
        'symbolic link',
        'file search',
        'follow'
      ]}
      className="flex items-center justify-between gap-4 py-2"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label>{translate(TITLE_KEY, TITLE_FALLBACK)}</Label>
        <p className="text-xs text-muted-foreground">
          {translate(DESCRIPTION_KEY, DESCRIPTION_FALLBACK)}
        </p>
      </div>
      <SettingsSegmentedControl
        ariaLabel={translate(TITLE_KEY, TITLE_FALLBACK)}
        value={settings.quickOpenFollowSymlinks === true ? 'on' : 'off'}
        onChange={(option) => updateSettings({ quickOpenFollowSymlinks: option === 'on' })}
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
