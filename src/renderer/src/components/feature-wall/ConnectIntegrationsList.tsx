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
import { useIntegrationProviderStatusRefresh } from '@/components/settings/use-integration-provider-status-refresh'
import { IntegrationProgress, IntegrationStep } from './connect-integration-step'
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
                ? translate('auto.components.feature.wall.ConnectIntegrationsList.list_end', ', and ')
                : translate('auto.components.feature.wall.ConnectIntegrationsList.list_pair', ' and ')
              : translate('auto.components.feature.wall.ConnectIntegrationsList.list_mid', ', ')
            : null}
          <span className="font-semibold text-foreground">{name}</span>
        </Fragment>
      ))}
    </>
  )
}

// Progressive two-step integration setup: first connect a code host for review
// status, then a task source. Only one step is active at a time — connecting a
// step collapses it to a summary and promotes the next. Done-state is driven by
// real provider connection status, never an optimistic click.
export function ConnectIntegrationsList(): React.JSX.Element {
  useIntegrationProviderStatusRefresh()
  const status = useIntegrationConnectionStatus()
  // Lets a done step reopen inline via "Change" without losing its connected
  // state. Cleared once the user collapses it again.
  const [reopened, setReopened] = useState<{ review: boolean; task: boolean }>({
    review: false,
    task: false
  })

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
  const taskResolved = flow.taskResolved
  const reviewExpanded = !reviewDone || reopened.review
  const reviewCanToggle = reviewDone
  // Step 2 only becomes reachable once review status is connected.
  const taskExpanded = reviewDone && (!taskResolved || reopened.task)

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] leading-snug text-muted-foreground">
          {translate(
            'auto.components.feature.wall.ConnectIntegrationsList.3a1fcdddad',
            'Two quick steps: connect where your code is reviewed, then where your team plans work.'
          )}
        </p>
        <IntegrationProgress states={[flow.review, flow.task]} />
      </div>

      <IntegrationStep
        index={0}
        state={flow.review}
        expanded={reviewExpanded}
        title={translate(
          'auto.components.feature.wall.ConnectIntegrationsList.38c72bdc65',
          'Keep review status in view'
        )}
        description={translate(
          'auto.components.feature.wall.ConnectIntegrationsList.1e6e3201fd',
          'Connect a review provider so Orca can show PR or MR status, checks, and reviews while agents work.'
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
        onToggle={() => setReopened((r) => ({ ...r, review: !r.review }))}
        canToggle={reviewCanToggle}
      >
        <GitHubIntegrationCard />
        <GitLabIntegrationCard />
        <BitbucketIntegrationCard />
        <AzureDevOpsIntegrationCard />
        <GiteaIntegrationCard />
      </IntegrationStep>

      <IntegrationStep
        index={1}
        state={flow.task}
        expanded={taskExpanded}
        title={translate(
          'auto.components.feature.wall.ConnectIntegrationsList.0ec37ecdd1',
          'Start agents from tasks'
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
        onToggle={() => setReopened((r) => ({ ...r, task: !r.task }))}
        canToggle={reviewDone}
      >
        <LinearIntegrationCard />
        <JiraIntegrationCard />
        <p className="px-1 pt-1 text-[12px] leading-snug text-muted-foreground">
          {translate(
            'auto.components.feature.wall.ConnectIntegrationsList.code_host_tasks_caption',
            "Your code host's issues also work as tasks."
          )}
        </p>
        <GitHubIntegrationCard />
        <GitLabIntegrationCard />
      </IntegrationStep>
    </div>
  )
}
