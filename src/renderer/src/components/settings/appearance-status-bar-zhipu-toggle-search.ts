import type { StatusBarItem } from '../../../../shared/ui-chrome-types'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getZhipuStatusBarToggleSearchEntry(): {
  id: StatusBarItem
  title: string
  description: string
  keywords: string[]
  toggleDescription: string
} {
  return {
    id: 'zhipu',
    title: translate(
      'auto.components.settings.appearance.search.zhipu.title',
      'Zhipu / Z.AI Usage'
    ),
    description: translate(
      'auto.components.settings.appearance.search.zhipu.description',
      'Show Zhipu / Z.AI GLM Coding Plan usage in the status bar.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.896eb53fd4',
        'status bar'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.zhipuKeyword', 'zhipu'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.zai', 'z.ai'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.glm', 'glm'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.25e51b62ee',
        'rate limit'
      )
    ],
    toggleDescription: translate(
      'settings.appearance.statusBar.zhipuToggleDescription',
      'Show Zhipu / Z.AI GLM Coding Plan usage for the active workspace.'
    )
  }
}
