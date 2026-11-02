import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getPlaneAgentSkillPaneSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.plane.agent.skill.search.title', 'Plane'),
    description: translate(
      'auto.components.settings.plane.agent.skill.search.description',
      'Plane skill status, usage examples, and links to Task Sources setup.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.plane.agent.skill.search.plane',
        'plane'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.plane.agent.skill.search.tickets',
        'tickets'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.plane.agent.skill.search.issues',
        'issues'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.plane.agent.skill.search.skill',
        'skill'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.plane.agent.skill.search.orcaPlane',
        'orca-plane'
      )
    ]
  }
])
