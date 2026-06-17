import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getDevRulesPaneSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.dev.rules.search.title', 'Dev Rules'),
    description: translate(
      'auto.components.settings.dev.rules.search.description',
      'Coding principles and additive system messages written into each worktree’s AGENTS.md and CLAUDE.md, scoped globally or per project.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.dev.rules.search.dev', 'dev'),
      ...translateSearchKeyword('auto.components.settings.dev.rules.search.rule', 'rule'),
      ...translateSearchKeyword('auto.components.settings.dev.rules.search.rules', 'rules'),
      ...translateSearchKeyword('auto.components.settings.dev.rules.search.coding', 'coding'),
      ...translateSearchKeyword(
        'auto.components.settings.dev.rules.search.principles',
        'principles'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.dev.rules.search.system',
        'system message'
      ),
      ...translateSearchKeyword('auto.components.settings.dev.rules.search.prompt', 'prompt'),
      ...translateSearchKeyword(
        'auto.components.settings.dev.rules.search.instructions',
        'instructions'
      ),
      ...translateSearchKeyword('auto.components.settings.dev.rules.search.agents', 'AGENTS.md'),
      ...translateSearchKeyword('auto.components.settings.dev.rules.search.claude', 'CLAUDE.md'),
      ...translateSearchKeyword('auto.components.settings.dev.rules.search.global', 'global'),
      ...translateSearchKeyword('auto.components.settings.dev.rules.search.project', 'project')
    ]
  }
])
