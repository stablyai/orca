import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getQuickCommandsPaneSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.quick.commands.search.4c8945952b', 'Quick Commands'),
    description: translate(
      'auto.components.settings.quick.commands.search.d691c4e8d8',
      'Saved terminal commands that can be launched from any terminal, scoped globally or to a specific project.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.quick.commands.search.236d4cfac8',
        'quick'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.quick.commands.search.fecb031823',
        'command'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.quick.commands.search.cfffa6cdb6',
        'commands'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.quick.commands.search.0073cf8ce9',
        'terminal'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.quick.commands.search.d07d130849',
        'shortcut'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.quick.commands.search.a26ecdb77b',
        'snippet'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.quick.commands.search.8bf43c2dad',
        'global'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.quick.commands.search.f58b92a48f',
        'project'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.quick.commands.search.89d2a9ad9f',
        'repo'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.quick.commands.search.1c5bdcd0f2',
        'repository'
      ),
      ...translateSearchKeyword('auto.components.settings.quick.commands.search.2d8aff42be', 'run'),
      ...translateSearchKeyword(
        'auto.components.settings.quick.commands.search.0b78c4a165',
        'launch'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.quick.commands.search.b949a7c0a0',
        'pnpm'
      ),
      ...translateSearchKeyword('auto.components.settings.quick.commands.search.b86c727100', 'npm'),
      ...translateSearchKeyword('auto.components.settings.quick.commands.search.3c316e6ef8', 'yarn')
    ]
  }
])
