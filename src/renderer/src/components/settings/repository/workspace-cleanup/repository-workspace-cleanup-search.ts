import type { Repo } from '../../../../../../shared/repo-types'
import type { SettingsSearchEntry } from '../../search/settings-search'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { searchKeywordTranslator } from '../../search/settings-search-keywords'

export function getRepositoryWorkspaceCleanupSearchEntry(
  repo: Repo,
  t: Translate = translate
): SettingsSearchEntry {
  const translateSearchKeyword = searchKeywordTranslator(t)
  return {
    title: t('components.settings.repository.workspaceCleanup.rules', 'Cleanup rules'),
    description: t(
      'components.settings.repository.workspaceCleanup.rulesDescription',
      'Which workspace cleanup rules apply to this project.'
    ),
    keywords: [
      repo.displayName,
      ...translateSearchKeyword(
        'components.settings.repository.workspaceCleanup.keywordCleanup',
        'cleanup'
      ),
      ...translateSearchKeyword(
        'components.settings.repository.workspaceCleanup.keywordDelete',
        'delete'
      ),
      ...translateSearchKeyword(
        'components.settings.repository.workspaceCleanup.keywordMerged',
        'merged'
      )
    ]
  }
}
