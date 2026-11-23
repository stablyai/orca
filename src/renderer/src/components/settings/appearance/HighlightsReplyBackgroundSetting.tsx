import type React from 'react'
import type { HighlightsReplyBackground } from '../../../../../shared/bots-global-settings'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { SettingsRow, SettingsSegmentedControl } from '../form-controls/SettingsFormControls'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { getHighlightsReplyBackgroundEntry } from './highlights-reply-background-search'

export function HighlightsReplyBackgroundSetting({
  value,
  onChange,
  forceVisible
}: {
  value: HighlightsReplyBackground
  onChange: (value: HighlightsReplyBackground) => void
  forceVisible: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const { targetSectionId, title, description, keywords } = getHighlightsReplyBackgroundEntry()
  const tinted = value === 'blue' || value === 'teal'
  return (
    <SearchableSetting
      id={targetSectionId}
      title={title}
      description={description}
      keywords={keywords}
      forceVisible={forceVisible}
    >
      <SettingsRow
        label={title}
        description={description}
        control={
          <SettingsSegmentedControl<HighlightsReplyBackground>
            ariaLabel={title}
            size="sm"
            value={value}
            onChange={onChange}
            options={[
              {
                value: 'blue',
                label: t('settings.appearance.highlightsReplyBackground.blue', 'Blue')
              },
              {
                value: 'teal',
                label: t('settings.appearance.highlightsReplyBackground.teal', 'Teal')
              },
              {
                value: 'neutral',
                label: t('settings.appearance.highlightsReplyBackground.neutral', 'Neutral')
              }
            ]}
          />
        }
      />
      <p className="mb-1.5 text-xs text-muted-foreground">
        {t('settings.appearance.highlightsReplyBackground.previewLabel', 'Comment preview')}
      </p>
      <div
        data-highlights-reply-background={tinted ? value : undefined}
        className={cn(
          'mb-3 rounded-md px-2.5 py-1.5 text-xs text-foreground inset-ring',
          tinted ? 'highlights-reply-surface' : 'bg-muted inset-ring-border'
        )}
      >
        <span className="font-medium">{t('bots.items.activity.you', 'You')}</span>
        {' · '}
        {t(
          'settings.appearance.highlightsReplyBackground.preview',
          'Thanks, this is ready to review.'
        )}
      </div>
    </SearchableSetting>
  )
}
