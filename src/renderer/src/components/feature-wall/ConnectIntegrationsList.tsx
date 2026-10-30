import { Fragment, useState } from 'react'
import { Trans } from 'react-i18next'
import {
  AzureDevOpsIntegrationCard,
  BitbucketIntegrationCard,
  GiteaIntegrationCard,
  GitHubIntegrationCard,
  GitLabIntegrationCard
} from '@/components/settings/source-control-integration-cards'
import {
  JiraIntegrationCard,
  LinearIntegrationCard
} from '@/components/settings/task-tracker-integration-cards'
import {
  IntegrationCardGroup,
  IntegrationCardPresentationProvider
} from '@/components/settings/integration-card-presentation'
import { useIntegrationProviderStatusRefresh } from '@/components/settings/use-integration-provider-status-refresh'
import { IntegrationStep } from './connect-integration-step'
import {
  deriveIntegrationFlowState,
  useIntegrationConnectionStatus
} from './use-integration-connection-status'
import { i18n, translate } from '@/i18n/i18n'

function TaskSourceNameList(props: { names: readonly string[] }): React.JSX.Element {
  return (
    <>
      {props.names.map((name, index) => (
        <Fragment key={name}>
          {index > 0
            ? index === props.names.length - 1
              ? props.names.length > 2
                ? translate(
                    'auto.components.feature.wall.ConnectIntegrationsList.list_end',
                    ', and '
                  )
                : translate(
                    'auto.components.feature.wall.ConnectIntegrationsList.list_pair',
                    ' and '
                  )
              : translate('auto.components.feature.wall.ConnectIntegrationsList.list_mid', ', ')
            : null}
          <span className="font-semibold text-foreground">{name}</span>
        </Fragment>
      ))}
    </>
  )
}

// Recommend review before tasks without gating either; completion follows real provider status.
export function ConnectIntegrationsList(): React.JSX.Element {
  useIntegrationProviderStatusRefresh()
  const status = useIntegrationConnectionStatus()
  const [reviewReopened, setReviewReopened] = useState(false)

  const flow = deriveIntegrationFlowState({
    reviewConnected: status.reviewConnected,
    trackerProviderName: status.trackerProviderName,
    codeHostTaskProviderName: status.codeHostTaskProviderName,
    trackerChecking: status.trackerChecking
  })
  const reviewDone = status.reviewConnected
  const trackerDone = status.trackerProviderName !== null
  const reviewExpanded = !reviewDone || reviewReopened
  const reviewCanToggle = reviewDone
  // Reset manual expansion when connection facts change so stale choices cannot override the new defaults.
  const [taskToggle, setTaskToggle] = useState<{
    expanded: boolean
    whenTrackerDone: boolean
    whenReviewDone: boolean
  } | null>(null)
  const taskToggleCurrent =
    taskToggle !== null &&
    taskToggle.whenTrackerDone === trackerDone &&
    taskToggle.whenReviewDone === reviewDone
  // Keep dedicated trackers discoverable until one connects, even when code-host issues already satisfy tasks.
  const taskExpanded = taskToggleCurrent ? taskToggle.expanded : reviewDone && !trackerDone

  return (
    <IntegrationCardPresentationProvider value="setup-guide">
      <div className="space-y-2.5">
        <IntegrationStep
          index={0}
          state={flow.review}
          expanded={reviewExpanded}
          title={translate(
            'auto.components.feature.wall.ConnectIntegrationsList.review_step_title',
            'See PR status while agents work'
          )}
          description={translate(
            'auto.components.feature.wall.ConnectIntegrationsList.review_step_description',
            'Connect a review provider so Orca can show PR or MR status, checks, and reviews.'
          )}
          summary={
            <Trans
              i18n={i18n}
              defaults={translate(
                'auto.components.feature.wall.ConnectIntegrationsList.reviewConnectedSummary',
                '<provider>{{provider}}</provider> connected for review status',
                { provider: status.reviewProviderName }
              )}
              components={{ provider: <span className="font-semibold text-foreground" /> }}
            />
          }
          onToggle={() => setReviewReopened((value) => !value)}
          canToggle={reviewCanToggle}
        >
          <IntegrationCardGroup>
            <GitHubIntegrationCard />
            <GitLabIntegrationCard />
            <BitbucketIntegrationCard />
            <AzureDevOpsIntegrationCard />
            <GiteaIntegrationCard />
          </IntegrationCardGroup>
        </IntegrationStep>

        <IntegrationStep
          index={1}
          state={flow.task}
          expanded={taskExpanded}
          title={translate(
            'auto.components.feature.wall.ConnectIntegrationsList.task_step_title',
            'Start agents on your tasks without leaving Orca'
          )}
          description={translate(
            'auto.components.feature.wall.ConnectIntegrationsList.33b650af52',
            'Connect where your team tracks work. Orca starts workspaces with the issue title, link, and context already attached.'
          )}
          summary={
            status.trackerProviderName ? (
              <Trans
                i18n={i18n}
                defaults={translate(
                  'auto.components.feature.wall.ConnectIntegrationsList.tasksConnectedSummary',
                  '<sources/> connected for tasks'
                )}
                components={{ sources: <TaskSourceNameList names={status.taskSourceNames} /> }}
              />
            ) : (
              <Trans
                i18n={i18n}
                defaults={translate(
                  'auto.components.feature.wall.ConnectIntegrationsList.codeHostTasksSummary',
                  '<provider>{{provider}}</provider> issues available as tasks · add Linear or Jira if your team plans work there',
                  { provider: status.codeHostTaskProviderName }
                )}
                components={{ provider: <span className="font-semibold text-foreground" /> }}
              />
            )
          }
          onToggle={() =>
            setTaskToggle({
              expanded: !taskExpanded,
              whenTrackerDone: trackerDone,
              whenReviewDone: reviewDone
            })
          }
        >
          <IntegrationCardGroup>
            <LinearIntegrationCard />
            <JiraIntegrationCard />
          </IntegrationCardGroup>
          <p className="px-1 pt-0.5 text-[12px] leading-snug text-muted-foreground">
            {translate(
              'auto.components.feature.wall.ConnectIntegrationsList.code_host_tasks_caption',
              "Your code host's issues also work as tasks."
            )}
          </p>
          <IntegrationCardGroup>
            <GitHubIntegrationCard />
            <GitLabIntegrationCard />
          </IntegrationCardGroup>
        </IntegrationStep>
      </div>
    </IntegrationCardPresentationProvider>
  )
}
