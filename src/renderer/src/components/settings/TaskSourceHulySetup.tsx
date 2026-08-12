import { useState } from 'react'
import { HulyConnectionDialog } from '@/components/huly-connection-dialog'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { HulyAgentSkillPane } from './HulyAgentSkillPane'
import { TaskSourceShowInTasksStep } from './TaskSourceShowInTasksStep'
import { TaskSourceStepRow } from './TaskSourceStepRow'
import { translate } from '@/i18n/i18n'

type TaskSourceHulySetupProps = {
  connected: boolean
  checking: boolean
  visible: boolean
  onToggleVisible: () => void
  onOpenIntegrations: () => void
  canHide: boolean
}

// Why: Huly is account-backed (CLI + credential), so the wizard mirrors Linear's
// three steps: connect → install agent skill → show in Tasks.
export function TaskSourceHulySetup({
  connected,
  checking,
  visible,
  onToggleVisible,
  onOpenIntegrations,
  canHide
}: TaskSourceHulySetupProps): React.JSX.Element {
  const checkHulyConnection = useAppStore((s) => s.checkHulyConnection)
  const [dialogOpen, setDialogOpen] = useState(false)

  const connectState = checking ? 'in-progress' : connected ? 'done' : 'pending'

  return (
    <>
      <ol className="divide-y divide-border/50">
        <TaskSourceStepRow
          index={1}
          state={connectState}
          title={translate(
            'auto.components.settings.TaskSourceHulySetup.connectTitle',
            'Connect Huly'
          )}
          description={translate(
            'auto.components.settings.TaskSourceHulySetup.connectDescription',
            'Add a Huly instance URL, workspace, and credential so Orca can browse issues.'
          )}
          action={
            <Button
              type="button"
              size="sm"
              variant={connected ? 'outline' : 'default'}
              onClick={connected ? onOpenIntegrations : () => setDialogOpen(true)}
            >
              {connected
                ? translate(
                    'auto.components.settings.TaskSourceHulySetup.manageAccess',
                    'Manage connections'
                  )
                : translate(
                    'auto.components.settings.TaskSourceHulySetup.addAccess',
                    'Add Huly access'
                  )}
            </Button>
          }
        >
          {connected ? (
            <p className="text-[11px] text-muted-foreground">
              {translate(
                'auto.components.settings.TaskSourceHulySetup.connectedHint',
                'Connections are stored for the active runtime. Add more instances any time.'
              )}
            </p>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => void checkHulyConnection(true)}
            >
              {translate(
                'auto.components.settings.TaskSourceHulySetup.recheck',
                'Re-check connection'
              )}
            </Button>
          )}
        </TaskSourceStepRow>

        <TaskSourceStepRow
          index={2}
          state="done"
          title={translate(
            'auto.components.settings.TaskSourceHulySetup.installSkillTitle',
            'Install agent skill (optional)'
          )}
          description={translate(
            'auto.components.settings.TaskSourceHulySetup.installSkillDescription',
            'Install the huly-cli skill so coding agents can read and update tickets.'
          )}
        >
          <HulyAgentSkillPane compact />
        </TaskSourceStepRow>

        <TaskSourceShowInTasksStep
          index={3}
          providerLabel="Huly"
          visible={visible}
          onToggleVisible={onToggleVisible}
          canHide={canHide}
        />
      </ol>

      <HulyConnectionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        overlayClassName="z-[110]"
        contentClassName="z-[120]"
      />
    </>
  )
}
