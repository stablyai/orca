import type { Repo } from '../../../../shared/repo-types'
import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getRepositoryFormatOnSaveSearchEntries(repo: Repo): SettingsSearchEntry[] {
  return [
    {
      title: translate('auto.components.settings.repository.search.formatOnSave', 'Format on Save'),
      description: translate(
        'auto.components.settings.repository.search.formatOnSaveDescription',
        "Run this project's formatter after Orca saves a file."
      ),
      keywords: [
        repo.displayName,
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.formatOnSaveKeyword',
          'format on save'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.formatterKeyword',
          'formatter'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.prettierKeyword',
          'prettier'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.biomeKeyword',
          'biome'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.gofmtKeyword',
          'gofmt rustfmt ruff'
        )
      ]
    },
    {
      title: translate(
        'auto.components.settings.repository.search.formatterCommand',
        'Formatter Command'
      ),
      description: translate(
        'auto.components.settings.repository.search.formatterCommandDescription',
        'Shell command run in the worktree root after each save.'
      ),
      keywords: [
        repo.displayName,
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.formatterCommandKeyword',
          'formatter command'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.formatOnSaveKeyword',
          'format on save'
        )
      ]
    },
    {
      title: translate(
        'auto.components.settings.repository.search.formatIncludedFiles',
        'Included Files'
      ),
      description: translate(
        'auto.components.settings.repository.search.formatIncludedFilesDescription',
        'Globs limiting which saved files run the formatter.'
      ),
      keywords: [
        repo.displayName,
        ...translateSearchKeyword('auto.components.settings.repository.search.globKeyword', 'glob'),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.formatIncludeKeyword',
          'format include'
        )
      ]
    }
  ]
}
