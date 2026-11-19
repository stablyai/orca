import type { SettingsSearchEntry } from '../search/settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../search/settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getAccountsZcodePlanSearchEntries = createLocalizedCatalog(
  (): SettingsSearchEntry[] => [
    {
      title: translate(
        'auto.components.settings.accounts.search.zcodePlan.0db9d0465f',
        'GLM coding plan'
      ),
      description: translate(
        'auto.components.settings.accounts.search.zcodePlan.description',
        'Track Z.AI or Zhipu (BigModel) GLM Coding Plan usage. Pick the site and save the plan API key.'
      ),
      keywords: [
        ...translateSearchKeyword(
          'auto.components.settings.accounts.search.zcodePlan.kw.glm',
          'glm'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.accounts.search.zcodePlan.kw.zai',
          'zai'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.accounts.search.zcodePlan.kw.zhipu',
          'zhipu'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.accounts.search.zcodePlan.kw.bigmodel',
          'bigmodel'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.accounts.search.zcodePlan.kw.codingPlan',
          'coding plan'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.accounts.search.zcodePlan.kw.rateLimit',
          'rate limit'
        )
      ]
    }
  ]
)
