import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import type { SettingsSearchEntry } from '../search/settings-search'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export const getHighlightsReplyBackgroundEntry = createLocalizedCatalog(
  (): SettingsSearchEntry => ({
    targetSectionId: 'appearance-highlights-reply-background',
    title: translate('settings.appearance.highlightsReplyBackground.title', 'My reply background'),
    description: translate(
      'settings.appearance.highlightsReplyBackground.description',
      'Choose a color for your comments and quick replies in Highlights.'
    ),
    keywords: [
      ...translateSearchKeyword('settings.appearance.highlightsReplyBackground.colors', 'colors'),
      ...translateSearchKeyword('settings.appearance.highlightsReplyBackground.blue', 'Blue'),
      ...translateSearchKeyword('settings.appearance.highlightsReplyBackground.teal', 'Teal'),
      ...translateSearchKeyword('settings.appearance.highlightsReplyBackground.neutral', 'Neutral'),
      ...translateSearchKeyword(
        'settings.appearance.highlightsReplyBackground.search',
        'Highlights reply background'
      )
    ]
  })
)
