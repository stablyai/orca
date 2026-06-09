import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getTasksPaneSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.tasks.search.5b8e4aace5', 'Task Providers'),
    description: translate(
      'auto.components.settings.tasks.search.765f0c544d',
      'Choose which task providers appear in the Tasks page and sidebar shortcuts.'
    ),
    keywords: [
      translate('auto.components.settings.tasks.search.2ec54bee51', 'tasks'),
      translate('auto.components.settings.tasks.search.cf0e3e0c2f', 'provider'),
      translate('auto.components.settings.tasks.search.3d81c26d78', 'source'),
      translate('auto.components.settings.tasks.search.c10ac2125e', 'github'),
      translate('auto.components.settings.tasks.search.11f001cdd4', 'gitlab'),
      translate('auto.components.settings.tasks.search.412ec3c702', 'linear'),
      translate('auto.components.settings.tasks.search.5430396e11', 'jira'),
      translate('auto.components.settings.tasks.search.604d8e4089', 'atlassian'),
      translate('auto.components.settings.tasks.search.44083ae418', 'display'),
      translate('auto.components.settings.tasks.search.58cda6f9c0', 'hide')
    ]
  }
])
