import { translate } from '@/i18n/i18n'
import type { Repo } from '../../../../shared/repo-types'
import type { SettingsSearchEntry } from './settings-search'
import { translateSearchKeyword } from './settings-search-keywords'

const KEY = 'auto.components.settings.RepositoryLanguageServersSection'

export function getRepositoryLanguageServersSearchEntries(repo: Repo): SettingsSearchEntry[] {
  return [
    {
      title: translate(`${KEY}.title`, 'Language Servers'),
      description: translate(
        `${KEY}.description`,
        'Go to definition, find references and hover for this project. Enabling a server runs code from this repository.'
      ),
      keywords: [
        repo.displayName,
        ...translateSearchKeyword(`${KEY}.search.lsp`, 'lsp', { englishOnly: true }),
        ...translateSearchKeyword(`${KEY}.search.languageServer`, 'language server'),
        ...translateSearchKeyword(`${KEY}.search.goToDefinition`, 'go to definition'),
        ...translateSearchKeyword(`${KEY}.search.findReferences`, 'find references'),
        ...translateSearchKeyword(`${KEY}.search.hover`, 'hover'),
        ...translateSearchKeyword(`${KEY}.search.ruby`, 'ruby', { englishOnly: true }),
        ...translateSearchKeyword(`${KEY}.search.rubyLsp`, 'ruby-lsp', { englishOnly: true }),
        ...translateSearchKeyword(`${KEY}.search.solargraph`, 'solargraph', { englishOnly: true }),
        ...translateSearchKeyword(`${KEY}.search.typescript`, 'typescript', { englishOnly: true }),
        ...translateSearchKeyword(`${KEY}.search.gemInstall`, 'gem install', { englishOnly: true })
      ]
    }
  ]
}
