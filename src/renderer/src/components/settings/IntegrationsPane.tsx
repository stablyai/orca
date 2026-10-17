import {
  AzureDevOpsIntegrationCard,
  BitbucketIntegrationCard,
  GiteaIntegrationCard,
  GitHubIntegrationCard,
  GitLabIntegrationCard
} from './source-control-integration-cards'
import { JiraIntegrationCard, LinearIntegrationCard } from './task-tracker-integration-cards'
import { DiscordPresenceIntegrationCard } from './discord-presence-integration-card'
import { useIntegrationProviderStatusRefresh } from './use-integration-provider-status-refresh'
import { translate } from '@/i18n/i18n'
import { isWebClientLocation } from '@/lib/web-client-location'
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

      {/* Why: presence talks to the Discord app on this computer, which a browser client cannot reach. */}
      {isWebClientLocation() ? null : (
        <section className="space-y-3">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-foreground">
              {translate(
                'auto.components.settings.IntegrationsPane.activitySharing',
                'Activity sharing'
              )}
            </h3>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.IntegrationsPane.activitySharingDescription',
                'Let other apps on this computer show what Orca is doing.'
              )}
            </p>
          </div>
          <div className="space-y-3">
            <DiscordPresenceIntegrationCard />
          </div>
        </section>
      )}
    </div>
  )
}
