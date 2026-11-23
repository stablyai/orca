import { useState } from 'react'
import { ClickUpTokenDialog } from '@/components/integrations/task-trackers/clickup-token-dialog'
import { Button } from '@/components/ui/button'
import { TaskSourceShowInTasksStep } from './TaskSourceShowInTasksStep'
import { TaskSourceStepRow } from './TaskSourceStepRow'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { clickupOwnerContextKey } from '@/store/slices/clickup/clickup-read-coordination'
import { getConnectStepState, type ConnectStepProps } from './task-source-setup-state'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

export function ClickUpSetupSteps(
  props: ConnectStepProps & {
    owner: RuntimeClientTarget
    onConnected: () => void
    onOpenIntegrations: () => void
  }
): React.JSX.Element {
  const t = useTranslate()
  const [dialogOpen, setDialogOpen] = useState(false)
  const { owner } = props
  // Matched inside the selector so the live runtime key is never read during render.
  const runtimeUpdateRequired = useAppStore(
    (s) =>
      s.clickupRuntimeUpdateRequired && s.clickupStatusContextKey === clickupOwnerContextKey(owner)
  )

  return (
    <>
      <ol className="divide-y divide-border/50">
        <TaskSourceStepRow
          index={1}
          state={getConnectStepState(props)}
          title={t('taskProviders.clickup.setup.connectTitle', 'Connect ClickUp')}
          description={
            runtimeUpdateRequired
              ? t(
                  'taskProviders.clickup.runtimeUpdateBody',
                  'Update the remote runtime to connect ClickUp.'
                )
              : t(
                  'taskProviders.clickup.setup.connectDescription',
                  'Add a personal API token from ClickUp Settings > Apps. One token covers every Workspace you belong to.'
                )
          }
          action={
            runtimeUpdateRequired ? null : (
              <Button
                type="button"
                size="sm"
                variant={props.connected ? 'outline' : 'default'}
                onClick={props.connected ? props.onOpenIntegrations : () => setDialogOpen(true)}
              >
                {props.connected
                  ? t('taskProviders.clickup.setup.manage', 'Manage token')
                  : t('taskProviders.clickup.setup.add', 'Add ClickUp access')}
              </Button>
            )
          }
        />
        <TaskSourceShowInTasksStep
          index={2}
          providerLabel={t('taskProviders.clickup.setup.providerLabel', 'ClickUp')}
          visible={props.visible}
          canHide={props.canHide}
          onToggleVisible={props.onToggleVisible}
        />
      </ol>
      <ClickUpTokenDialog
        owner={props.owner}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onConnected={props.onConnected}
      />
    </>
  )
}
