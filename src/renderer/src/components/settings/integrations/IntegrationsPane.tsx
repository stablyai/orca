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
import { useContext } from 'react'
import { cn } from '@/lib/class-names'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import {
  SETTINGS_TARGET_HIGHLIGHT_CLASS_NAME,
  SettingsTargetHighlightContext
} from '../section-layout/settings-target-highlight'
import { INTEGRATION_SETTING_TARGET_IDS } from './integrations-search'
import { useTranslate } from '@/i18n/use-translate'

// Flat presentation turns each provider into one row: -mx-4 cancels its inset, and inner rules are dropped so only rows divide.
function ProviderRow({
  id,
  children
}: {
  id: string
  children: React.ReactNode
}): React.JSX.Element {
  const highlighted = useContext(SettingsTargetHighlightContext) === id
  return (
    <div
      id={id}
      data-settings-row=""
      className={cn(
        'scroll-mt-6 [&_.border-t]:border-t-0 [&>*]:-mx-4',
        highlighted && SETTINGS_TARGET_HIGHLIGHT_CLASS_NAME
      )}
    >
      {children}
    </div>
  )
}

export function IntegrationsPane(): React.JSX.Element {
  const t = useTranslate()
  useIntegrationProviderStatusRefresh()

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
          <ProviderRow id={INTEGRATION_SETTING_TARGET_IDS.github}>
            <GitHubIntegrationCard />
          </ProviderRow>
          <ProviderRow id={INTEGRATION_SETTING_TARGET_IDS.gitlab}>
            <GitLabIntegrationCard />
          </ProviderRow>
          <ProviderRow id={INTEGRATION_SETTING_TARGET_IDS.bitbucket}>
            <BitbucketIntegrationCard />
          </ProviderRow>
          <ProviderRow id={INTEGRATION_SETTING_TARGET_IDS.azuredevops}>
            <AzureDevOpsIntegrationCard />
          </ProviderRow>
          <ProviderRow id={INTEGRATION_SETTING_TARGET_IDS.gitea}>
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
          <ProviderRow id={INTEGRATION_SETTING_TARGET_IDS.linear}>
            <LinearIntegrationCard />
          </ProviderRow>
          <ProviderRow id={INTEGRATION_SETTING_TARGET_IDS.jira}>
            <JiraIntegrationCard />
          </ProviderRow>
        </SettingsGroup>
      </div>
    </IntegrationCardPresentationProvider>
  )
}
