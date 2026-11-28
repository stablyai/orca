import type React from 'react'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import {
  normalizeMarkdownReadingWidth,
  type MarkdownReadingWidth
} from '../../../../../shared/settings/markdown-reading-width'
import { useTranslate } from '@/i18n/use-translate'
import { Label } from '../../ui/label'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsSegmentedControl } from '../form-controls/SettingsFormControls'
import { GENERAL_SETTING_ANCHORS } from '../general/general-setting-anchors'

type MarkdownReadingWidthSettingProps = {
  settings: Pick<GlobalSettings, 'markdownReadingWidth'>
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function MarkdownReadingWidthSetting({
  settings,
  updateSettings
}: MarkdownReadingWidthSettingProps): React.JSX.Element {
  const t = useTranslate()
  const title = t('settings.editor.markdownWidth', 'Markdown content width')
  const description = t(
    'settings.editor.markdownWidthDescription',
    'How wide the reading column grows in a wide Markdown pane.'
  )

  return (
    <SearchableSetting
      id={GENERAL_SETTING_ANCHORS.markdownWidth}
      title={title}
      description={description}
      keywords={['markdown', 'width', 'reading', 'full', 'wide', 'line length']}
      className="flex items-center justify-between gap-4 py-3"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label>{title}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <SettingsSegmentedControl<MarkdownReadingWidth>
        ariaLabel={title}
        value={normalizeMarkdownReadingWidth(settings.markdownReadingWidth)}
        onChange={(width) => updateSettings({ markdownReadingWidth: width })}
        options={[
          {
            value: 'narrow',
            label: t('settings.editor.markdownWidthNarrow', 'Narrow')
          },
          { value: 'wide', label: t('settings.editor.markdownWidthWide', 'Wide') },
          { value: 'full', label: t('settings.editor.markdownWidthFull', 'Full') }
        ]}
      />
    </SearchableSetting>
  )
}
