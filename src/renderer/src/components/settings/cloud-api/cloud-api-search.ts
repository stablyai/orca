import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export const getCloudApiKeysSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.cloudApi.keys.title', 'API keys'),
    description: translate(
      'auto.components.settings.cloudApi.searchDescription',
      'Create and revoke Orca Cloud API keys, connect MCP clients and control agent access.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.cloudApi.keywordToken', 'token'),
      ...translateSearchKeyword('auto.components.settings.cloudApi.keywordMcp', 'mcp'),
      ...translateSearchKeyword('auto.components.settings.cloudApi.keywordCli', 'cli'),
      ...translateSearchKeyword('auto.components.settings.cloudApi.keywordAudit', 'audit log'),
      ...translateSearchKeyword('auto.components.settings.cloudApi.keywordCloud', 'cloud')
    ]
  }
])

export const getCloudRoutinesSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.cloudRoutines.title', 'Routines'),
    description: translate(
      'auto.components.settings.cloudRoutines.searchDescription',
      'Run agents in Orca Cloud on a schedule, on GitHub events or from a webhook.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.cloudRoutines.keywordSchedule',
        'schedule'
      ),
      ...translateSearchKeyword('auto.components.settings.cloudRoutines.keywordCron', 'cron'),
      ...translateSearchKeyword('auto.components.settings.cloudRoutines.keywordWebhook', 'webhook'),
      ...translateSearchKeyword('auto.components.settings.cloudRoutines.keywordGithub', 'github'),
      ...translateSearchKeyword('auto.components.settings.cloudRoutines.keywordCloud', 'cloud')
    ]
  }
])
