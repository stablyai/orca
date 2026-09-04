import type { StatusBarItem } from '../../../../shared/ui-chrome-types'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getZaiStatusBarToggleSearchEntry(): {
  id: StatusBarItem
  title: string
  description: string
  keywords: string[]
  toggleDescription: string
} {
  return {
    id: 'zai',
    title: translate('auto.components.settings.appearance.search.zaiUsageTitle', 'Z.AI Usage'),
    description: translate(
      'auto.components.settings.appearance.search.zaiUsageDescription',
      'Show Z.AI Coding Plan usage in the status bar.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.896eb53fd4',
        'status bar'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.zaiKeyword', 'z.ai'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.zaiGlmKeyword', 'glm'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.de586def95',
        'subscription'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.zaiOpencodeKeyword',
        'opencode'
      )
    ],
    toggleDescription: translate(
      'settings.appearance.statusBar.zaiToggleDescription',
      'Show Z.AI Coding Plan usage when signed in through opencode auth.'
    )
  }
}
