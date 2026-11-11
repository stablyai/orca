import { useState } from 'react'
import { JiraConnectDialog } from '@/components/jira-connect-dialog'
import { Button } from '@/components/ui/button'
import { TaskSourceShowInTasksStep } from './TaskSourceShowInTasksStep'
import { TaskSourceStepRow } from './TaskSourceStepRow'
import { useTranslate } from '@/i18n/use-translate'
import { getConnectStepState, type ConnectStepProps } from './task-source-setup-state'

export function JiraSetupSteps(
  props: ConnectStepProps & { onConnected: () => void; onOpenIntegrations: () => void }
): React.JSX.Element {
  const t = useTranslate()
  const [dialogOpen, setDialogOpen] = useState(false)

  return (
    <>
      <ol className="divide-y divide-border/50">
        <TaskSourceStepRow
          index={1}
          state={getConnectStepState(props)}
          title={t('auto.components.settings.TasksPane.connectJiraTitle', 'Connect Jira')}
          description={t(
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
                ? t('auto.components.settings.TasksPane.manageJira', 'Manage keys')
                : t('auto.components.settings.TasksPane.addJira', 'Add Jira access')}
            </Button>
          }
        />
        <TaskSourceShowInTasksStep
          index={2}
          providerLabel={t('auto.components.settings.TasksPane.6b23a34f6d', 'Jira')}
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
