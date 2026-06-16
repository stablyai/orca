import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getGitProviderApiBudgetSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.git.search.ff86e354c4', 'GitHub API Budget'),
    description: translate(
      'auto.components.settings.git.search.1139f61512',
      'Current GitHub CLI REST, Search, and GraphQL rate limits.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.git.search.d088806071', 'github'),
      ...translateSearchKeyword('auto.components.settings.git.search.16f53f7323', 'gh'),
      ...translateSearchKeyword('auto.components.settings.git.search.65b69d9f80', 'graphql'),
      ...translateSearchKeyword('auto.components.settings.git.search.b7e52124c7', 'rate limit'),
      ...translateSearchKeyword('auto.components.settings.git.search.40f9b815fd', 'api budget')
    ]
  },
  {
    title: translate('auto.components.settings.git.search.83ecb3f470', 'GitLab API Budget'),
    description: translate(
      'auto.components.settings.git.search.2b4a72885d',
      'Current GitLab CLI REST rate-limit headers when available.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.git.search.4808f065b3', 'gitlab'),
      ...translateSearchKeyword('auto.components.settings.git.search.ead733645f', 'glab'),
      ...translateSearchKeyword('auto.components.settings.git.search.b7e52124c7', 'rate limit'),
      ...translateSearchKeyword('auto.components.settings.git.search.40f9b815fd', 'api budget')
    ]
  }
])
