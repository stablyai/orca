import type React from 'react'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import {
  normalizeMarkdownDefaultViewMode,
  type MarkdownDefaultViewMode
} from '../../../../../shared/markdown-default-view-mode'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { Label } from '../../ui/label'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsSegmentedControl } from '../form-controls/SettingsFormControls'

type MarkdownDefaultViewSettingProps = {
  settings: Pick<GlobalSettings, 'markdownDefaultViewMode'>
}

export function MarkdownDefaultViewSetting({
  settings
}: MarkdownDefaultViewSettingProps): React.JSX.Element {
  // Why: the store action keeps already-open Markdown tabs on the view they show.
  const setMarkdownDefaultViewMode = useAppStore((s) => s.setMarkdownDefaultViewMode)
  const title = translate(
    'auto.components.settings.GeneralEditorSettingsSection.markdownDefaultView',
    'Default Markdown View'
  )
  const description = translate(
    'auto.components.settings.GeneralEditorSettingsSection.markdownDefaultViewDesc',
    'The view Markdown files open in. Right-click the view switcher in a Markdown tab to change it there.'
  )

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={['markdown', 'default', 'view', 'source', 'rich', 'editor', 'raw']}
      className="flex items-center justify-between gap-4 py-2"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label>{title}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <SettingsSegmentedControl<MarkdownDefaultViewMode>
        ariaLabel={title}
        value={normalizeMarkdownDefaultViewMode(settings.markdownDefaultViewMode)}
        onChange={(mode) => setMarkdownDefaultViewMode(mode)}
        options={[
          {
            value: 'source',
            label: translate('auto.components.editor.EditorViewToggle.4d6ccb7ba6', 'Source')
          },
          {
            value: 'rich',
            label: translate('auto.components.editor.EditorViewToggle.aff15f94f5', 'Rich Editor')
          }
        ]}
      />
    </SearchableSetting>
  )
}
