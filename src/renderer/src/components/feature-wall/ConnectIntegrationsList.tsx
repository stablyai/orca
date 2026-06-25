import { Fragment, useState } from 'react'
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
import { translate } from '@/i18n/i18n'

// Bold provider names joined into a natural-language list ("Linear and
// GitHub", "Linear, Jira, and GitHub") for the task-step summary.
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

// Progressive two-step integration setup: first connect a code host for review
// status, then a task source. The order is a recommendation, not a gate — step
// 2 starts collapsed but opens on click so tracker-first users aren't blocked.
// Connecting step 1 collapses it to a summary and expands step 2, which stays
// open until a dedicated tracker connects so Linear/Jira remain discoverable.
// Done-state is driven by real provider connection status, never an
// optimistic click.
export function ConnectIntegrationsList(): React.JSX.Element {
  useIntegrationProviderStatusRefresh()
  const status = useIntegrationConnectionStatus()
  // Lets the done review step reopen inline via "Change" without losing its
  // connected state. Cleared once the user collapses it again.
  const [reviewReopened, setReviewReopened] = useState(false)

  // A code host doubles as a task source, so a connected GitHub/GitLab
  // resolves step 2 on its own. The collapsed summary still invites a
  // dedicated tracker, and "Change" reopens the step to connect one.
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
  // User's explicit expand/collapse of step 2, snapshotted against the
  // connection state so a provider connecting (or disconnecting) restores the
  // default for the new state instead of keeping a stale manual choice.
  const [taskToggle, setTaskToggle] = useState<{
    expanded: boolean
    whenTrackerDone: boolean
    whenReviewDone: boolean
  } | null>(null)
  const taskToggleCurrent =
    taskToggle !== null &&
    taskToggle.whenTrackerDone === trackerDone &&
    taskToggle.whenReviewDone === reviewDone
  // Step 2 defaults collapsed while step 1 is still active (but opens on
  // click — review is not a prerequisite for connecting a tracker), stays open
  // even when the code host already resolved it so Linear/Jira remain
  // discoverable, and collapses only once a dedicated tracker connects.
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
            <>
              <span className="font-semibold text-foreground">{status.reviewProviderName}</span>{' '}
              {translate(
                'auto.components.feature.wall.ConnectIntegrationsList.5b3577a492',
                'connected for review status'
              )}
            </>
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
              <>
                <TaskSourceNameList names={status.taskSourceNames} />{' '}
                {translate(
                  'auto.components.feature.wall.ConnectIntegrationsList.3dddb2d565',
                  'connected for tasks'
                )}
              </>
            ) : (
              <>
                <span className="font-semibold text-foreground">
                  {status.codeHostTaskProviderName}
                </span>{' '}
                {translate(
                  'auto.components.feature.wall.ConnectIntegrationsList.code_host_tasks_summary',
                  'issues available as tasks · add Linear or Jira if your team plans work there'
                )}
              </>
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
