import type { Repo } from '../../../../shared/types'
import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getRepositoryGitAuthorSearchEntries(repo: Repo): SettingsSearchEntry[] {
  return [
    {
      title: translate('auto.components.settings.repository.search.eec3995dc6', 'Git AI Author'),
      description: translate(
        'auto.components.settings.repository.search.6cc5c65e64',
        'Project-specific git generation overrides.'
      ),
      keywords: [
        repo.displayName,
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.a47f51127e',
          'source control'
        ),
        ...translateSearchKeyword('auto.components.settings.repository.search.cfad7ce5f3', 'ai'),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.eec39b3de6',
          'commit message'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.5ff7fe1ade',
          'pull request'
        ),
        ...translateSearchKeyword('auto.components.settings.repository.search.8068d8d0f1', 'pr'),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.917dce844a',
          'branch name'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.130d76dc16',
          'rename'
        ),
        ...translateSearchKeyword('auto.components.settings.repository.search.fa3131f223', 'model'),
        ...translateSearchKeyword('auto.components.settings.repository.search.fff8834983', 'prompt')
      ]
    },
    {
      title: translate('auto.components.settings.repository.search.31bd0a2420', 'MCP Configs'),
      description: translate(
        'auto.components.settings.repository.search.3c31801626',
        'Inspect project-level MCP server config files.'
      ),
      keywords: [
        repo.displayName,
        ...translateSearchKeyword('auto.components.settings.repository.search.343f0a508c', 'mcp'),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.16dc7a4637',
          'model context protocol'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.e760e3fae7',
          '.mcp.json'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.26f42fe773',
          '.cursor/mcp.json'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.db11b337c4',
          '.claude.json'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.d73fb47b45',
          '.claude/mcp.json'
        )
      ]
    }
  ]
}
