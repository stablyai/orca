import { useAppStore } from '../../../store/index'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { matchesSettingsSearch } from '../search/settings-search'
import { GitHubRateLimitPanel } from '../../github/github-rate-limit-display'
import { GitLabRateLimitPanel } from '../../gitlab/gitlab-rate-limit-display'
import { useTranslate } from '@/i18n/use-translate'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'

type GitProviderApiBudgetPaneProps = {
  settingsSearchQuery?: string
  /** The host chosen at the top of Settings; budgets come from that host's CLI. */
  target: RuntimeClientTarget
}

export function GitProviderApiBudgetPane({
  settingsSearchQuery,
  target
}: GitProviderApiBudgetPaneProps): React.JSX.Element | null {
  const t = useTranslate()
  const storeSearchQuery = useAppStore((s) => s.settingsSearchQuery)
  const searchQuery = settingsSearchQuery ?? storeSearchQuery

  const visibleSections = [
    matchesSettingsSearch(searchQuery, {
      title: t('auto.components.settings.GitPane.fdbcd676b0', 'GitHub API budget'),
      description: t(
        'auto.components.settings.GitPane.aa204f185f',
        'Current GitHub CLI REST, Search, and GraphQL rate limits.'
      ),
      keywords: [
        t('auto.components.settings.GitPane.32dca11189', 'github'),
        t('auto.components.settings.GitPane.895d3f70b8', 'gh'),
        t('auto.components.settings.GitPane.2cde9044a8', 'graphql'),
        t('auto.components.settings.GitPane.b9c011fbc2', 'rate limit'),
        t('auto.components.settings.GitPane.cdd793134e', 'api budget')
      ]
    }) ? (
      <SearchableSetting
        key="github-api-budget"
        title={t('auto.components.settings.GitPane.fdbcd676b0', 'GitHub API budget')}
        description={t(
          'auto.components.settings.GitPane.aa204f185f',
          'Current GitHub CLI REST, Search, and GraphQL rate limits.'
        )}
        keywords={['github', 'gh', 'graphql', 'rate limit', 'api budget']}
        className="space-y-3 py-3"
      >
        <GitHubRateLimitPanel target={target} />
      </SearchableSetting>
    ) : null,
    matchesSettingsSearch(searchQuery, {
      title: t('auto.components.settings.GitPane.f2765fbbf6', 'GitLab API budget'),
      description: t(
        'auto.components.settings.GitPane.c4f610d057',
        'Current GitLab CLI REST rate-limit headers when available.'
      ),
      keywords: [
        t('auto.components.settings.GitPane.8a527d48e3', 'gitlab'),
        t('auto.components.settings.GitPane.3072428ac7', 'glab'),
        t('auto.components.settings.GitPane.b9c011fbc2', 'rate limit'),
        t('auto.components.settings.GitPane.cdd793134e', 'api budget')
      ]
    }) ? (
      <SearchableSetting
        key="gitlab-api-budget"
        title={t('auto.components.settings.GitPane.f2765fbbf6', 'GitLab API budget')}
        description={t(
          'auto.components.settings.GitPane.c4f610d057',
          'Current GitLab CLI REST rate-limit headers when available.'
        )}
        keywords={['gitlab', 'glab', 'rate limit', 'api budget']}
        className="space-y-3 py-3"
      >
        <GitLabRateLimitPanel target={target} />
      </SearchableSetting>
    ) : null
  ].filter(Boolean)

  if (visibleSections.length === 0) {
    return null
  }

  // Put diagnostic budgets after everyday Git/AI controls.
  return <SettingsGroup>{visibleSections}</SettingsGroup>
}
