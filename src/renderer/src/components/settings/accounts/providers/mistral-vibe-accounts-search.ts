import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translateSearchKeyword } from '../../search/settings-search-keywords'

export const MISTRAL_VIBE_ACCOUNTS_SECTION_ID = 'accounts-mistral-vibe'

export const getAccountsMistralVibeSearchEntries = createLocalizedCatalog(() => [
  {
    targetSectionId: MISTRAL_VIBE_ACCOUNTS_SECTION_ID,
    title: translate('accounts.mistralVibe.searchTitle', 'Mistral Vibe Usage'),
    description: translate(
      'accounts.mistralVibe.searchDescription',
      'Monthly Vibe Code budget from the vibe CLI sign-in or MISTRAL_API_KEY.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.appearance.search.mistral', 'mistral'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.vibe', 'vibe'),
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.e949b08ffb',
        'rate limit'
      ),
      ...translateSearchKeyword('auto.components.settings.accounts.search.86edc96bc9', 'status bar')
    ]
  }
])
