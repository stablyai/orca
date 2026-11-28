import { useState } from 'react'
import { GiteaConnectDialog } from '@/components/integrations/source-control/gitea-connect-dialog'
import { Button } from '@/components/ui/button'
import { TaskSourceShowInTasksStep } from './TaskSourceShowInTasksStep'
import { TaskSourceStepRow } from './TaskSourceStepRow'
import { useTranslate } from '@/i18n/use-translate'
import { getConnectStepState, type ConnectStepProps } from './task-source-setup-state'

export function GiteaSetupSteps(
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
          title={t('auto.components.settings.TasksPane.connectGiteaTitle', 'Connect Gitea')}
          description={t(
            'auto.components.settings.TasksPane.connectGiteaDescription',
            'Add a Gitea or Forgejo server with a personal access token.'
          )}
          action={
            <Button
              type="button"
              size="sm"
              variant={props.connected ? 'outline' : 'default'}
              onClick={props.connected ? props.onOpenIntegrations : () => setDialogOpen(true)}
            >
              {props.connected
                ? t('auto.components.settings.TasksPane.manageGitea', 'Manage servers')
                : t('auto.components.settings.TasksPane.addGitea', 'Add Gitea server')}
            </Button>
          }
        />
        <TaskSourceShowInTasksStep
          index={2}
          providerLabel={t('auto.components.settings.TasksPane.giteaLabel', 'Gitea')}
          visible={props.visible}
          canHide={props.canHide}
          onToggleVisible={props.onToggleVisible}
        />
      </ol>
      <GiteaConnectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onConnected={props.onConnected}
      />
    </>
  )
}
