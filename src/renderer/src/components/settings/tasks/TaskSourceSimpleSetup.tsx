import { useState } from 'react'
import { JiraConnectDialog } from '@/components/jira-connect-dialog'
import { Button } from '@/components/ui/button'
import { TaskSourceShowInTasksStep } from './TaskSourceShowInTasksStep'
import { TaskSourceStepRow } from './TaskSourceStepRow'
import { translate } from '@/i18n/i18n'

type ConnectStepProps = {
  visible: boolean
  canHide: boolean
  onToggleVisible: () => void
  connected: boolean
  checking: boolean
}

function getConnectStepState(props: ConnectStepProps): 'in-progress' | 'done' | 'pending' {
  if (props.checking) {
    return 'in-progress'
  }
  return props.connected ? 'done' : 'pending'
}

export function CodeHostSetupSteps(
  props: ConnectStepProps & {
    providerLabel: string
    unavailable?: boolean
    onOpenIntegrations: () => void
    onRetryConnection: () => void
  }
): React.JSX.Element {
  const connectionDescription = props.unavailable
    ? translate(
        'auto.components.settings.TasksPane.connectionCheckUnavailable',
        "Orca couldn't check this connection. Try again, or open Integrations for setup details."
      )
    : translate(
        'auto.components.settings.TasksPane.connectCodeHostDescription',
        'Install and authenticate the CLI under Integrations so Orca can load issues.'
      )

  return (
    <ol className="divide-y divide-border/50">
      <TaskSourceStepRow
        index={1}
        state={getConnectStepState(props)}
        title={translate(
          'auto.components.settings.TasksPane.connectProviderTitle',
          'Connect {{provider}}',
          { provider: props.providerLabel }
        )}
        description={connectionDescription}
        action={
          <Button
            type="button"
            size="sm"
            variant={props.connected ? 'outline' : 'default'}
            onClick={props.unavailable ? props.onRetryConnection : props.onOpenIntegrations}
          >
            {props.unavailable
              ? translate('auto.components.settings.TasksPane.retryConnection', 'Try again')
              : props.connected
                ? translate('auto.components.settings.TasksPane.openIntegrations', 'Integrations')
                : translate(
                    'auto.components.settings.TasksPane.connectInIntegrations',
                    'Set up in Integrations'
                  )}
          </Button>
        }
      />
      <TaskSourceShowInTasksStep
        index={2}
        providerLabel={props.providerLabel}
        visible={props.visible}
        canHide={props.canHide}
        onToggleVisible={props.onToggleVisible}
      />
    </ol>
  )
}

export function JiraSetupSteps(
  props: ConnectStepProps & { onConnected: () => void; onOpenIntegrations: () => void }
): React.JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(false)

  return (
    <>
      <ol className="divide-y divide-border/50">
        <TaskSourceStepRow
          index={1}
          state={getConnectStepState(props)}
          title={translate('auto.components.settings.TasksPane.connectJiraTitle', 'Connect Jira')}
          description={translate(
            'auto.components.settings.TasksPane.connectJiraDescription',
            'Add a Jira Cloud site or self-hosted instance with an API token or PAT.'
          )}
          action={
            <Button
              type="button"
              size="sm"
              variant={props.connected ? 'outline' : 'default'}
              onClick={props.connected ? props.onOpenIntegrations : () => setDialogOpen(true)}
            >
              {props.connected
                ? translate('auto.components.settings.TasksPane.manageJira', 'Manage keys')
                : translate('auto.components.settings.TasksPane.addJira', 'Add Jira access')}
            </Button>
          }
        />
        <TaskSourceShowInTasksStep
          index={2}
          providerLabel={translate('auto.components.settings.TasksPane.6b23a34f6d', 'Jira')}
          visible={props.visible}
          canHide={props.canHide}
          onToggleVisible={props.onToggleVisible}
        />
      </ol>
      <JiraConnectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onConnected={props.onConnected}
      />
    </>
  )
}
