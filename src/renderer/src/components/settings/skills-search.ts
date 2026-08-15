import { translate } from '@/i18n/i18n'
import type { SettingsSearchEntry } from './settings-search'

export function getSkillsPaneSearchEntries(): SettingsSearchEntry[] {
  return [
    {
      title: translate('auto.components.settings.skillsSearch.title', 'Skills'),
      description: translate(
        'auto.components.settings.skillsSearch.description',
        'Browse local Codex, Claude, Agent Skills, bundled, repository, and plugin skills.'
      ),
      keywords: [
        translate('auto.components.settings.skillsSearch.keywordGallery', 'skills gallery'),
        translate('auto.components.settings.skillsSearch.keywordCodex', 'codex skills'),
        translate('auto.components.settings.skillsSearch.keywordClaude', 'claude skills'),
        translate('auto.components.settings.skillsSearch.keywordPlugins', 'plugin skills')
      ]
    }
  ]
}
