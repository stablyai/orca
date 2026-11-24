import { GENERAL_SETTING_ANCHORS } from '../general/general-setting-anchors'
import type React from 'react'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { normalizeMarkdownReadingWidth } from '../../../../../shared/editor/markdown/markdown-reading-width'
import { useTranslate } from '@/i18n/use-translate'
import { Label } from '../../ui/label'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsSegmentedControl } from '../form-controls/SettingsFormControls'

type MarkdownReadingWidthSettingProps = {
  settings: Pick<GlobalSettings, 'markdownReadingWidth'>
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function MarkdownReadingWidthSetting({
  settings,
  updateSettings
}: MarkdownReadingWidthSettingProps): React.JSX.Element {
  const t = useTranslate()
  const title = t('settings.general.markdownReadingWidthTitle', 'Markdown reading width')
  const description = t(
    'settings.general.markdownReadingWidthDescription',
    'How wide Markdown text runs in the editor and preview. Centered caps the column at about 60 characters.'
  )

  return (
    <SearchableSetting
      id={GENERAL_SETTING_ANCHORS.markdownReadingWidth}
      title={title}
      description={description}
      keywords={[
        'markdown',
        'width',
        'reading',
        'line length',
        'centered',
        'full width',
        'full-width'
      ]}
      className="flex items-center justify-between gap-4 py-3"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label>{title}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <SettingsSegmentedControl<'centered' | 'full'>
        ariaLabel={title}
        value={normalizeMarkdownReadingWidth(settings.markdownReadingWidth)}
        onChange={(mode) => updateSettings({ markdownReadingWidth: mode })}
        options={[
          {
            value: 'centered',
            label: t('settings.general.markdownReadingWidthCentered', 'Centered')
          },
          {
            value: 'full',
            label: t('settings.general.markdownReadingWidthFull', 'Full width')
          }
        ]}
      />
    </SearchableSetting>
  )
}
