import {
  AzureDevOpsIntegrationCard,
  GiteaIntegrationCard
} from '../../integrations/source-control/token-source-control-integration-cards'
import { BitbucketIntegrationCard } from '../../integrations/source-control/bitbucket-integration-card'
import {
  GitHubIntegrationCard,
  GitLabIntegrationCard
} from '../../integrations/source-control/cli-source-control-integration-cards'
import { JiraIntegrationCard } from '../../integrations/task-trackers/jira-integration-card'
import { LinearIntegrationCard } from '../../integrations/task-trackers/linear-integration-card'
import { useIntegrationProviderStatusRefresh } from '../../../hooks/use-integration-provider-status-refresh'
import { translate } from '@/i18n/i18n'

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
        </div>
      </section>
    </div>
  )
}
