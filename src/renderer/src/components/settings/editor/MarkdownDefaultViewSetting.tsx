import { GENERAL_SETTING_ANCHORS } from '../general/general-setting-anchors'
import type React from 'react'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import {
  normalizeMarkdownDefaultViewMode,
  type MarkdownDefaultViewMode
} from '../../../../../shared/markdown-default-view-mode'
import { useTranslate } from '@/i18n/use-translate'
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
  const t = useTranslate()
  // Why: the store action keeps already-open Markdown tabs on the view they show.
  const setMarkdownDefaultViewMode = useAppStore((s) => s.setMarkdownDefaultViewMode)
  const title = t(
    'auto.components.settings.GeneralEditorSettingsSection.1dd79964bf',
    'Default Markdown view'
  )
  const description = t(
    'auto.components.settings.GeneralEditorSettingsSection.markdownDefaultViewDesc',
    'The view Markdown files open in. Right-click the view switcher in a Markdown tab to change it there.'
  )

  return (
    <SearchableSetting
      id={GENERAL_SETTING_ANCHORS.markdownView}
      title={title}
      description={description}
      keywords={['markdown', 'default', 'view', 'source', 'rich', 'editor', 'raw']}
      className="flex items-center justify-between gap-4 py-3"
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
            label: t('auto.components.editor.EditorViewToggle.4d6ccb7ba6', 'Source')
          },
          {
            value: 'rich',
            label: t('auto.components.editor.EditorViewToggle.bcaccaddf1', 'Rich editor')
          }
        ]}
      />
    </SearchableSetting>
  )
}
