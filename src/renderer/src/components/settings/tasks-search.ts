import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

// Share keywords between the pane and settings-search index.
export const getTasksPaneSearchKeywords = createLocalizedCatalog(() => [
  ...translateSearchKeyword('auto.components.settings.tasks.search.2ec54bee51', 'tasks'),
  ...translateSearchKeyword('auto.components.settings.tasks.search.cf0e3e0c2f', 'provider'),
  ...translateSearchKeyword('auto.components.settings.tasks.search.3d81c26d78', 'source'),
  ...translateSearchKeyword('auto.components.settings.tasks.search.c10ac2125e', 'github'),
  ...translateSearchKeyword('auto.components.settings.tasks.search.11f001cdd4', 'gitlab'),
  ...translateSearchKeyword('auto.components.settings.tasks.search.412ec3c702', 'linear'),
  ...translateSearchKeyword('auto.components.settings.tasks.search.5430396e11', 'jira'),
  ...translateSearchKeyword('auto.components.settings.tasks.search.604d8e4089', 'atlassian'),
  ...translateSearchKeyword('auto.components.settings.tasks.search.44083ae418', 'display'),
  ...translateSearchKeyword('auto.components.settings.tasks.search.58cda6f9c0', 'hide'),
  ...translateSearchKeyword('auto.components.settings.tasks.search.setup', 'setup'),
  ...translateSearchKeyword('auto.components.settings.tasks.search.apiKey', 'api key'),
  ...translateSearchKeyword('auto.components.settings.tasks.search.skill', 'skill'),
  ...translateSearchKeyword('auto.components.settings.tasks.search.connect', 'connect')
])

export const getTasksPaneSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.tasks.search.5b8e4aace5', 'Task Providers'),
    description: translate(
      'auto.components.settings.tasks.search.providersDescription',
      'Connect task providers, install the Linear agent skill, and choose what appears in Tasks.'
    ),
    keywords: getTasksPaneSearchKeywords()
  }
])
