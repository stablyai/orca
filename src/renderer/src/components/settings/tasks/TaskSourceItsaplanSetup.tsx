import { useState } from 'react'
import { ItsaplanConnectDialog } from '@/components/itsaplan-connect-dialog'
import { Button } from '@/components/ui/button'
import { TaskSourceShowInTasksStep } from './TaskSourceShowInTasksStep'
import { TaskSourceStepRow } from './TaskSourceStepRow'
import { useTranslate } from '@/i18n/use-translate'
import { getConnectStepState, type ConnectStepProps } from './task-source-setup-state'

export function ItsaplanSetupSteps(
  props: ConnectStepProps & { onOpenIntegrations: () => void }
): React.JSX.Element {
  const t = useTranslate()
  const [dialogOpen, setDialogOpen] = useState(false)

  return (
    <>
      <ol className="divide-y divide-border/50">
        <TaskSourceStepRow
          index={1}
          state={getConnectStepState(props)}
          title={t('components.TaskSourceItsaplanSetup.connectTitle', "Connect It's a Plan")}
          description={t(
            'components.TaskSourceItsaplanSetup.connectDescription',
            "Add your self-hosted It's a Plan with an API key."
          )}
          action={
            <Button
              type="button"
              size="sm"
              variant={props.connected ? 'outline' : 'default'}
              onClick={props.connected ? props.onOpenIntegrations : () => setDialogOpen(true)}
            >
              {props.connected
                ? t('components.TaskSourceItsaplanSetup.manage', 'Manage keys')
                : t('components.TaskSourceItsaplanSetup.add', "Add It's a Plan access")}
            </Button>
          }
        />
        <TaskSourceShowInTasksStep
          index={2}
          providerLabel={t('components.TaskSourceItsaplanSetup.providerLabel', "It's a Plan")}
          visible={props.visible}
          canHide={props.canHide}
          onToggleVisible={props.onToggleVisible}
        />
      </ol>
      <ItsaplanConnectDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  )
}
