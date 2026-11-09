import type { Repo } from '../../../../../../shared/repo-types'
import type { SettingsSearchEntry } from '../../search/settings-search'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { searchKeywordTranslator } from '../../search/settings-search-keywords'

export function getRepositoryMcpConfigSearchEntries(
  repo: Repo,
  t: Translate = translate
): SettingsSearchEntry[] {
  const translateSearchKeyword = searchKeywordTranslator(t)
  return [
    {
      title: t('auto.components.settings.repository.search.31bd0a2420', 'MCP Configs'),
      description: t(
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
