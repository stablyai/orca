import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  DEFAULT_MARKDOWN_DEFAULT_VIEW_MODE,
  type MarkdownDefaultViewMode
} from '../../../../shared/markdown-default-view-mode'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { Label } from '../ui/label'
import { SettingsSegmentedControl } from './SettingsFormControls'

type MarkdownDefaultViewSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

function settingTitle(): string {
  return translate(
    'auto.components.settings.MarkdownDefaultViewSetting.2255066e40',
    'Default Markdown View'
  )
}

function settingDescription(): string {
  return translate(
    'auto.components.settings.MarkdownDefaultViewSetting.9cc24271f8',
    'Which view Markdown files open in. Switching views inside a tab still only affects that tab.'
  )
}

// Why: reuse the editor toggle's catalog keys so the segmented labels always read
// the same as the buttons they configure, in every locale.
function viewModeOptions(): readonly { value: MarkdownDefaultViewMode; label: string }[] {
  return [
    {
      value: 'source',
      label: translate('auto.components.editor.EditorViewToggle.4d6ccb7ba6', 'Source')
    },
    {
      value: 'rich',
      label: translate('auto.components.editor.EditorViewToggle.aff15f94f5', 'Rich Editor')
    },
    {
      value: 'preview',
      label: translate('auto.components.editor.EditorViewToggle.0d193dc03c', 'Preview')
    }
  ]
}

export function MarkdownDefaultViewSetting({
  settings,
  updateSettings
}: MarkdownDefaultViewSettingProps): React.JSX.Element {
  return (
    <SearchableSetting
      title={settingTitle()}
      description={settingDescription()}
      keywords={['markdown', 'md', 'view', 'preview', 'rich editor', 'source', 'default']}
      className="flex items-center justify-between gap-4 py-2"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label>{settingTitle()}</Label>
        <p className="text-xs text-muted-foreground">{settingDescription()}</p>
      </div>
      <SettingsSegmentedControl
        ariaLabel={settingTitle()}
        value={settings.markdownDefaultViewMode ?? DEFAULT_MARKDOWN_DEFAULT_VIEW_MODE}
        onChange={(markdownDefaultViewMode) => updateSettings({ markdownDefaultViewMode })}
        options={viewModeOptions()}
      />
    </SearchableSetting>
  )
}
