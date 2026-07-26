import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getLinearAgentSkillPaneSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.linear.agent.skill.search.title', 'Linear'),
    description: translate(
      'auto.components.settings.linear.agent.skill.search.description',
      'Give agents the skill to read and update your linked Linear tickets.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.linear.agent.skill.search.linear',
        'linear'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.linear.agent.skill.search.tickets',
        'tickets'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.linear.agent.skill.search.issues',
        'issues'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.linear.agent.skill.search.skill',
        'skill'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.linear.agent.skill.search.orcaLinear',
        'orca-linear'
      )
    ]
  }
])
