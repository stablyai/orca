import {
  AzureDevOpsIntegrationCard,
  BitbucketIntegrationCard,
  GiteaIntegrationCard,
  GitHubIntegrationCard,
  GitLabIntegrationCard
} from './source-control-integration-cards'
import {
  GiteaTaskIntegrationCard,
  JiraIntegrationCard,
  LinearIntegrationCard
} from './task-tracker-integration-cards'
import { useIntegrationProviderStatusRefresh } from './use-integration-provider-status-refresh'
import { translate } from '@/i18n/i18n'
export { getIntegrationsPaneSearchEntries } from './integrations-search'

export function IntegrationsPane(): React.JSX.Element {
  useIntegrationProviderStatusRefresh()

  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">
            {translate('auto.components.settings.IntegrationsPane.298c65ecac', 'Review providers')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.IntegrationsPane.1683acbac4',
              'Connect the source hosts Orca can use for pull requests, merge requests, checks, and review status.'
            )}
          </p>
        </div>
        <div className="space-y-3">
          <GitHubIntegrationCard />
          <GitLabIntegrationCard />
          <BitbucketIntegrationCard />
          <AzureDevOpsIntegrationCard />
          {/* Why: Gitea is both a review host and an issue tracker, so it shows
              here and again under Task providers via two distinct cards. */}
          <GiteaIntegrationCard />
        </div>
      </section>

      <section className="space-y-3">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">
            {translate('auto.components.settings.IntegrationsPane.70e885705b', 'Task providers')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.IntegrationsPane.3ba07f933b',
              'Connect issue trackers Orca can use to browse tasks and start workspaces with linked context.'
            )}
          </p>
        </div>
        <div className="space-y-3">
          <LinearIntegrationCard />
          <JiraIntegrationCard />
          {/* Why: task-tracker counterpart of the Review-providers Gitea card;
              same provider, surfaced for its issues/tasks. */}
          <GiteaTaskIntegrationCard />
        </div>
      </section>
    </div>
  )
}
