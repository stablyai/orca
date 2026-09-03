import type { StatusBarItem } from '../../../../shared/ui-chrome-types'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

/** Settings-search entry for the Appearance toggle that shows or hides the Z.ai status-bar segment. */
export function getZaiStatusBarToggleSearchEntry(): {
  id: StatusBarItem
  title: string
  description: string
  keywords: string[]
  toggleDescription: string
} {
  return {
    id: 'zai',
    title: translate('auto.components.settings.appearance.search.zaiUsageTitle', 'Z.ai Usage'),
    description: translate(
      'auto.components.settings.appearance.search.zaiUsageDescription',
      'Show GLM Coding Plan quota from your Z.ai API key.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.896eb53fd4',
        'status bar'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.zaiKeyword', 'z.ai'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.glmKeyword', 'glm'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.de586def95',
        'subscription'
      )
    ],
    toggleDescription: translate(
      'settings.appearance.statusBar.zaiToggleDescription',
      'Show Z.ai GLM Coding Plan quota when an API key is configured.'
    )
  }
}
