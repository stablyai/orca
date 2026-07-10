import { useAppStore } from '../../store'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'
import { GitHubRateLimitPanel } from '../github/github-rate-limit-display'
import { GitLabRateLimitPanel } from '../gitlab/gitlab-rate-limit-display'
import { translate } from '@/i18n/i18n'

type GitProviderApiBudgetPaneProps = {
  settingsSearchQuery?: string
}

export function GitProviderApiBudgetPane({
  settingsSearchQuery
}: GitProviderApiBudgetPaneProps): React.JSX.Element | null {
  const storeSearchQuery = useAppStore((s) => s.settingsSearchQuery)
  const searchQuery = settingsSearchQuery ?? storeSearchQuery

  const visibleSections = [
    matchesSettingsSearch(searchQuery, {
      title: translate('auto.components.settings.GitPane.612a440e57', 'GitHub API Budget'),
      description: translate(
        'auto.components.settings.GitPane.aa204f185f',
        'Current GitHub CLI REST, Search, and GraphQL rate limits.'
      ),
      keywords: [
        translate('auto.components.settings.GitPane.32dca11189', 'github'),
        translate('auto.components.settings.GitPane.895d3f70b8', 'gh'),
        translate('auto.components.settings.GitPane.2cde9044a8', 'graphql'),
        translate('auto.components.settings.GitPane.b9c011fbc2', 'rate limit'),
        translate('auto.components.settings.GitPane.cdd793134e', 'api budget')
      ]
    }) ? (
      <SearchableSetting
        key="github-api-budget"
        title={translate('auto.components.settings.GitPane.612a440e57', 'GitHub API Budget')}
        description={translate(
          'auto.components.settings.GitPane.aa204f185f',
          'Current GitHub CLI REST, Search, and GraphQL rate limits.'
        )}
        keywords={['github', 'gh', 'graphql', 'rate limit', 'api budget']}
        className="space-y-3"
      >
        <GitHubRateLimitPanel />
      </SearchableSetting>
    ) : null,
    matchesSettingsSearch(searchQuery, {
      title: translate('auto.components.settings.GitPane.0de4ae556c', 'GitLab API Budget'),
      description: translate(
        'auto.components.settings.GitPane.c4f610d057',
        'Current GitLab CLI REST rate-limit headers when available.'
      ),
      keywords: [
        translate('auto.components.settings.GitPane.8a527d48e3', 'gitlab'),
        translate('auto.components.settings.GitPane.3072428ac7', 'glab'),
        translate('auto.components.settings.GitPane.b9c011fbc2', 'rate limit'),
        translate('auto.components.settings.GitPane.cdd793134e', 'api budget')
      ]
    }) ? (
      <SearchableSetting
        key="gitlab-api-budget"
        title={translate('auto.components.settings.GitPane.0de4ae556c', 'GitLab API Budget')}
        description={translate(
          'auto.components.settings.GitPane.c4f610d057',
          'Current GitLab CLI REST rate-limit headers when available.'
        )}
        keywords={['gitlab', 'glab', 'rate limit', 'api budget']}
        className="space-y-3"
      >
        <GitLabRateLimitPanel />
      </SearchableSetting>
    ) : null
  ].filter(Boolean)

  if (visibleSections.length === 0) {
    return null
  }

  // Why: provider budgets are diagnostic, so they render after core git and AI
  // settings instead of competing with everyday branch and attribution controls.
  return <div className="space-y-4 border-t border-border/40 pt-4">{visibleSections}</div>
}
