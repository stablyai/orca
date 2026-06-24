import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getOrchestratorsSearchEntry(): SettingsSearchEntry {
  return {
    title: translate(
      'auto.components.settings.experimental.search.orchestrators.title',
      'Orcastrators'
    ),
    description: translate(
      'auto.components.settings.experimental.search.orchestrators.description',
      'A sidebar section for launching persistent coordinator chats that plan and run multi-worktree work.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.0d24759f14',
        'experimental'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.orchestrators.orchestrator',
        'orchestrator'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.orchestrators.orcastrate',
        'orcastrate'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.orchestrators.coordinator',
        'coordinator'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.orchestrators.agents',
        'agents'
      )
    ]
  }
}
