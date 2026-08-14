import type { StatusBarItem } from '../../../../shared/ui-chrome-types'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

type StatusBarToggleSearchEntry = {
  id: StatusBarItem
  title: string
  description: string
  keywords: string[]
  toggleDescription: string
}

export function getExtendedUsageStatusBarToggleSearchEntries(): StatusBarToggleSearchEntry[] {
  return [
    {
      id: 'grok',
      title: translate('auto.components.settings.appearance.search.f8e2a1c4b6', 'Grok Usage'),
      description: translate(
        'auto.components.settings.appearance.search.e7d1b0f3a5',
        'Show Grok weekly credit usage from Grok CLI OAuth.'
      ),
      keywords: [
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.896eb53fd4',
          'status bar'
        ),
        ...translateSearchKeyword('auto.components.settings.appearance.search.d6c0a9e2f4', 'grok'),
        ...translateSearchKeyword('auto.components.settings.appearance.search.c5b9f8d1e3', 'xai'),
        ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.de586def95',
          'subscription'
        )
      ],
      toggleDescription: translate(
        'settings.appearance.statusBar.grokToggleDescription',
        'Show Grok subscription credit usage when signed in via Grok CLI.'
      )
    },
    {
      id: 'zcode',
      title: translate('auto.components.settings.appearance.search.zcodeUsageTitle', 'ZCode Usage'),
      description: translate(
        'auto.components.settings.appearance.search.zcodeUsageDescription',
        'Show ZCode Coding Plan quota usage in the status bar.'
      ),
      keywords: [
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.896eb53fd4',
          'status bar'
        ),
        ...translateSearchKeyword('auto.components.settings.appearance.search.zcode', 'zcode'),
        ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
        ...translateSearchKeyword('auto.components.settings.appearance.search.zai', 'zai'),
        ...translateSearchKeyword('auto.components.settings.appearance.search.glm', 'glm')
      ],
      toggleDescription: translate(
        'settings.appearance.statusBar.zcodeToggleDescription',
        'Show ZCode Coding Plan quota usage.'
      )
    }
  ]
}
