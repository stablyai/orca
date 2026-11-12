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
import { IntegrationCardPresentationProvider } from '../../integrations/presentation/integration-card-presentation'
import { useIntegrationProviderStatusRefresh } from '../../../hooks/use-integration-provider-status-refresh'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { useTranslate } from '@/i18n/use-translate'
import { PluginIntegrationsGroup, PluginIntegrationSettings } from './PluginIntegrations'
import { usePluginIntegrationNavigation } from './plugin-integration-navigation'

// Flat presentation turns each provider into one row: -mx-4 cancels its inset, and inner rules are dropped so only rows divide.
function ProviderRow({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div data-settings-row="" className="[&_.border-t]:border-t-0 [&>*]:-mx-4">
      {children}
    </div>
  )
}

export function IntegrationsPane(): React.JSX.Element {
  const t = useTranslate()
  const pluginKey = usePluginIntegrationNavigation((state) => state.pluginKey)
  useIntegrationProviderStatusRefresh()
  if (pluginKey) {
    return <PluginIntegrationSettings key={pluginKey} pluginKey={pluginKey} />
  }

  return (
    <IntegrationCardPresentationProvider value="setup-guide">
      <div className="space-y-8">
        <SettingsGroup
          title={t('auto.components.settings.IntegrationsPane.298c65ecac', 'Review providers')}
          description={t(
            'auto.components.settings.IntegrationsPane.1683acbac4',
            'Connect the source hosts Orca can use for pull requests, merge requests, checks, and review status.'
          )}
        >
          <ProviderRow>
            <GitHubIntegrationCard />
          </ProviderRow>
          <ProviderRow>
            <GitLabIntegrationCard />
          </ProviderRow>
          <ProviderRow>
            <BitbucketIntegrationCard />
          </ProviderRow>
          <ProviderRow>
            <AzureDevOpsIntegrationCard />
          </ProviderRow>
          <ProviderRow>
            <GiteaIntegrationCard />
          </ProviderRow>
        </SettingsGroup>

        <SettingsGroup
          title={t('auto.components.settings.IntegrationsPane.70e885705b', 'Task providers')}
          description={t(
            'auto.components.settings.IntegrationsPane.3ba07f933b',
            'Connect issue trackers Orca can use to browse tasks and start workspaces with linked context.'
          )}
        >
          <ProviderRow>
            <LinearIntegrationCard />
          </ProviderRow>
          <ProviderRow>
            <JiraIntegrationCard />
          </ProviderRow>
        </SettingsGroup>
        <PluginIntegrationsGroup />
      </div>
    </IntegrationCardPresentationProvider>
  )
}
