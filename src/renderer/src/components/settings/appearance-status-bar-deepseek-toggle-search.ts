import type { StatusBarItem } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getDeepSeekStatusBarToggleSearchEntry(): {
  id: StatusBarItem
  title: string
  description: string
  keywords: string[]
  toggleDescription: string
} {
  return {
    id: 'deepseek',
    title: translate(
      'auto.components.settings.appearance.search.deepseekUsageTitle',
      'DeepSeek Usage'
    ),
    description: translate(
      'auto.components.settings.appearance.search.deepseekUsageDescription',
      'Show DeepSeek prepaid balance from DEEPSEEK_API_KEY.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.896eb53fd4',
        'status bar'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.deepseekKeyword',
        'deepseek'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.deepseekBalanceKeyword',
        'balance'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.deepseekApiKeyKeyword',
        'api key'
      )
    ],
    toggleDescription: translate(
      'settings.appearance.statusBar.deepseekToggleDescription',
      'Show DeepSeek prepaid balance when DEEPSEEK_API_KEY is set.'
    )
  }
}
