import type React from 'react'
import type { Repo } from '../../../../shared/repo-types'
import { RepositoryWorkspaceTrustStatus } from './RepositoryWorkspaceTrustStatus'
import { SearchableSetting } from './SearchableSetting'
import { getRepositoryWorkspaceTrustSearchTitle } from './repository-workspace-trust-search-entries'
import { translate } from '@/i18n/i18n'

/**
 * Sits between identity and hooks because workspace trust is the outer question
 * ("do I trust this location"), and applies to folder-opened projects too.
 */
export function RepositoryWorkspaceTrustSection({
  repo,
  forceVisible
}: {
  repo: Repo
  forceVisible: boolean
}): React.JSX.Element {
  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">{getRepositoryWorkspaceTrustSearchTitle()}</h2>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.RepositoryWorkspaceTrustSection.description',
            'The trust decision recorded for this project location. Trust is inheritable, so a decision recorded for a folder also covers everything nested beneath it.'
          )}
        </p>
      </div>
      <SearchableSetting
        title={getRepositoryWorkspaceTrustSearchTitle()}
        description={translate(
          'auto.components.settings.RepositoryWorkspaceTrustSection.settingDescription',
          'Review or change the trust decision recorded for this project location.'
        )}
        keywords={[repo.displayName, repo.path, 'trust', 'workspace trust', 'trusted', 'untrusted']}
        forceVisible={forceVisible}
      >
        <RepositoryWorkspaceTrustStatus repo={repo} />
      </SearchableSetting>
    </section>
  )
}
