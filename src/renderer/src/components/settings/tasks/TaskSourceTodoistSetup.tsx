import { useState } from 'react'
import { TodoistConnectDialog } from '@/components/integrations/task-trackers/todoist-connect-dialog'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { TaskSourceShowInTasksStep } from './TaskSourceShowInTasksStep'
import { TaskSourceStepRow } from './TaskSourceStepRow'
import { useTranslate } from '@/i18n/use-translate'
import { getConnectStepState, type ConnectStepProps } from './task-source-setup-state'

export function TodoistSetupSteps(props: ConnectStepProps): React.JSX.Element {
  const t = useTranslate()
  const [dialogOpen, setDialogOpen] = useState(false)
  const disconnectTodoist = useAppStore((s) => s.disconnectTodoist)
  const viewerEmail = useAppStore((s) => s.todoistStatus.viewer?.email)

  return (
    <>
      <ol className="divide-y divide-border/50">
        <TaskSourceStepRow
          index={1}
          state={getConnectStepState(props)}
          title={t('auto.components.settings.TasksPane.connectTodoistTitle', 'Connect Todoist')}
          description={
            props.connected && viewerEmail
              ? t(
                  'auto.components.settings.TasksPane.todoistConnectedAs',
                  'Connected as {{email}}.',
                  {
                    email: viewerEmail
                  }
                )
              : t(
                  'auto.components.settings.TasksPane.connectTodoistDescription',
                  'Add your Todoist API token from Todoist integration settings.'
                )
          }
          action={
            <Button
              type="button"
              size="sm"
              variant={props.connected ? 'outline' : 'default'}
              onClick={props.connected ? () => void disconnectTodoist() : () => setDialogOpen(true)}
            >
              {props.connected
                ? t('auto.components.settings.TasksPane.disconnectTodoist', 'Disconnect')
                : t('auto.components.settings.TasksPane.addTodoist', 'Add Todoist token')}
            </Button>
          }
        />
        <TaskSourceShowInTasksStep
          index={2}
          providerLabel={t('auto.components.settings.TasksPane.todoistLabel', 'Todoist')}
          visible={props.visible}
          canHide={props.canHide}
          onToggleVisible={props.onToggleVisible}
        />
      </ol>
      <TodoistConnectDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  )
}
