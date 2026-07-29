import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getTasksPaneSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.tasks.search.5b8e4aace5', 'Task Providers'),
    description: translate(
      'auto.components.settings.tasks.search.765f0c544d',
      'Choose which task providers appear in the Tasks page and sidebar shortcuts.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.tasks.search.2ec54bee51', 'tasks'),
      ...translateSearchKeyword('auto.components.settings.tasks.search.cf0e3e0c2f', 'provider'),
      ...translateSearchKeyword('auto.components.settings.tasks.search.3d81c26d78', 'source'),
      ...translateSearchKeyword('auto.components.settings.tasks.search.c10ac2125e', 'github'),
      ...translateSearchKeyword('auto.components.settings.tasks.search.11f001cdd4', 'gitlab'),
      ...translateSearchKeyword('auto.components.settings.tasks.search.412ec3c702', 'linear'),
      ...translateSearchKeyword('auto.components.settings.tasks.search.5430396e11', 'jira'),
      ...translateSearchKeyword('auto.components.settings.tasks.search.604d8e4089', 'atlassian'),
      ...translateSearchKeyword('auto.components.settings.tasks.search.44083ae418', 'display'),
      ...translateSearchKeyword('auto.components.settings.tasks.search.58cda6f9c0', 'hide')
    ]
  },
  {
    title: translate('auto.components.settings.tasks.search.9580d17a8c', 'Launch prompt template'),
    description: translate(
      'auto.components.settings.tasks.search.4253030e8d',
      'Leave empty to use the default. The issue identifier and URL variables are shown in the field placeholder.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.tasks.search.a1f2e3d4c5', 'linear'),
      ...translateSearchKeyword('auto.components.settings.tasks.search.b2f3e4d5c6', 'prompt'),
      ...translateSearchKeyword('auto.components.settings.tasks.search.c3f4e5d6b7', 'template'),
      ...translateSearchKeyword('auto.components.settings.tasks.search.d4f5e6c7b8', 'launch'),
      ...translateSearchKeyword('auto.components.settings.tasks.search.e5f6d7c8b9', 'instruction'),
      ...translateSearchKeyword('auto.components.settings.tasks.search.f6a7c8b9d0', 'identifier'),
      ...translateSearchKeyword('auto.components.settings.tasks.search.a7b8c9d0e1', 'url')
    ]
  }
])
