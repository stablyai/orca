import type { Repo } from '../../../../shared/repo-types'
import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

/** Shared so `RepositoryPane` can pick this section's entries out of the pane index by identity. */
export function getRepositoryWorkspaceTrustSearchTitle(): string {
  return translate('auto.components.settings.repository.search.workspaceTrust', 'Workspace Trust')
}

export function getRepositoryWorkspaceTrustSearchEntries(repo: Repo): SettingsSearchEntry[] {
  return [
    {
      title: getRepositoryWorkspaceTrustSearchTitle(),
      description: translate(
        'auto.components.settings.repository.search.workspaceTrustDescription',
        'Review or change the trust decision recorded for this project location.'
      ),
      keywords: [
        repo.displayName,
        repo.path,
        ...translateSearchKeyword('auto.components.settings.repository.search.trust', 'trust'),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.workspaceTrustKeyword',
          'workspace trust'
        ),
        ...translateSearchKeyword('auto.components.settings.repository.search.trusted', 'trusted'),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.untrusted',
          'untrusted'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.revokeTrust',
          'revoke trust'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.repository.search.trustedLocation',
          'trusted location'
        )
      ]
    }
  ]
}
