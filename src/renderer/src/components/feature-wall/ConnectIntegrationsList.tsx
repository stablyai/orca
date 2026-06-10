import { useState } from 'react'
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
import { getLocalPreflightContext, localPreflightContextKey } from '@/lib/local-preflight-context'
import { useAppStore } from '@/store'
import { CodeHostTaskNote, IntegrationProgress, IntegrationStep } from './connect-integration-step'
import {
  deriveIntegrationFlowState,
  useIntegrationConnectionStatus
} from './use-integration-connection-status'
import { translate } from '@/i18n/i18n'

// Progressive two-step integration setup: first connect a code host for review
// status, then a task source. Only one step is active at a time — connecting a
// step collapses it to a summary and promotes the next. Done-state is driven by
// real provider connection status, never an optimistic click.
export function ConnectIntegrationsList(): React.JSX.Element {
  useIntegrationProviderStatusRefresh()
  const status = useIntegrationConnectionStatus()
  const preflightContextKey = useAppStore((s) =>
    localPreflightContextKey(getLocalPreflightContext(s))
  )
  // Lets a done step reopen inline via "Change" without losing its connected
  // state. Cleared once the user collapses it again.
  const [reopened, setReopened] = useState<{ review: boolean; task: boolean }>({
    review: false,
    task: false
  })

  // A code host doubles as a task source, so once it connects the parent
  // checklist already counts tasks as satisfied. Step 2 still invites a
  // dedicated tracker; it resolves when one connects or the user accepts the
  // code host via "Use … issues". This stays truthful — we never claim a
  // tracker is connected when it isn't.
  const [acceptedCodeHostTaskProvider, setAcceptedCodeHostTaskProvider] = useState<{
    provider: 'GitHub' | 'GitLab'
    preflightContextKey: string
  } | null>(null)
  const taskAccepted =
    acceptedCodeHostTaskProvider?.provider === status.codeHostTaskProviderName &&
    acceptedCodeHostTaskProvider.preflightContextKey === preflightContextKey

  const flow = deriveIntegrationFlowState({
    reviewConnected: status.reviewConnected,
    trackerProviderName: status.trackerProviderName,
    taskAccepted,
    trackerChecking: status.trackerChecking
  })
  const reviewDone = status.reviewConnected
  const trackerDone = status.trackerProviderName !== null
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
              <span className="font-semibold text-foreground">{status.trackerProviderName}</span>{' '}
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
                'auto.components.feature.wall.ConnectIntegrationsList.bad3bbce10',
                'issues available as tasks'
              )}
            </>
          )
        }
        onToggle={() => setReopened((r) => ({ ...r, task: !r.task }))}
        canToggle={reviewDone}
      >
        <LinearIntegrationCard />
        <JiraIntegrationCard />
        {status.codeHostTaskProviderName && !trackerDone ? (
          <CodeHostTaskNote
            providerName={status.codeHostTaskProviderName}
            onAccept={() => {
              if (!status.codeHostTaskProviderName) {
                return
              }
              setAcceptedCodeHostTaskProvider({
                provider: status.codeHostTaskProviderName,
                preflightContextKey
              })
              setReopened((r) => ({ ...r, task: false }))
            }}
          />
        ) : null}
      </IntegrationStep>
    </div>
  )
}
