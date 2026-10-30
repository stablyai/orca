import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getIssueDraftAgentSearchEntry(): SettingsSearchEntry {
  return {
    title: translate(
      'auto.components.settings.experimental.search.issueDraftAgent.title',
      'Draft issues with an agent'
    ),
    description: translate(
      'auto.components.settings.experimental.search.issueDraftAgent.description',
      'Adds a panel beside the GitHub task list where you talk through new issues with your default agent in the project’s primary checkout. It files an issue only when you tell it to.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.0d24759f14',
        'experimental'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.issueDraftAgent.tasks',
        'tasks'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.issueDraftAgent.issues',
        'issues'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.issueDraftAgent.agent',
        'agent'
      )
    ]
  }
}
