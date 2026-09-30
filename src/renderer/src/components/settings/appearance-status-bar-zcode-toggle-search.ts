import type { StatusBarItem } from '../../../../shared/ui-chrome-types'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getZcodeStatusBarToggleSearchEntry(): {
  id: StatusBarItem
  title: string
  description: string
  keywords: string[]
  toggleDescription: string
} {
  return {
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
}
