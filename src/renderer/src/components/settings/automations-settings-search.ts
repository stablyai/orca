import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export const getAutomationsSettingsSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.automations.showButton', 'Show Automations Button'),
    description: translate(
      'auto.components.settings.automations.showButtonDescription',
      'Show the Automations shortcut in the sidebar.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.automations.keywordAutomations',
        'automations'
      ),
      ...translateSearchKeyword('auto.components.settings.automations.keywordSchedule', 'schedule'),
      ...translateSearchKeyword('auto.components.settings.automations.keywordAgent', 'agent'),
      ...translateSearchKeyword('auto.components.settings.automations.keywordRuns', 'runs')
    ]
  },
  {
    title: translate(
      'auto.components.settings.automations.expandProjectFolderOnAutomationRun',
      'Expand the project when a run starts'
    ),
    description: translate(
      'auto.components.settings.automations.expandProjectFolderOnAutomationRunDescription',
      'Open the collapsed project folder that holds the workspace for this run. The sidebar does not scroll.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.automations.keywordAutomations',
        'automations'
      ),
      ...translateSearchKeyword('auto.components.settings.automations.keywordExpand', 'expand'),
      ...translateSearchKeyword('auto.components.settings.automations.keywordCollapse', 'collapse'),
      ...translateSearchKeyword('auto.components.settings.automations.keywordFolder', 'folder'),
      ...translateSearchKeyword('auto.components.settings.automations.keywordProject', 'project')
    ]
  }
])
