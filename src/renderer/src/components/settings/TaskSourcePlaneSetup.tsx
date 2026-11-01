import { useState } from 'react'
import { PlaneConnectDialog } from '@/components/plane-connect-dialog'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'
import { TaskSourceShowInTasksStep } from './TaskSourceShowInTasksStep'
import { TaskSourceStepRow } from './TaskSourceStepRow'
import { usePlaneAgentSkillSetup } from './use-plane-agent-skill-setup'
import { ORCA_PLANE_SKILL_NAME } from '@/lib/agent-feature-install-commands'
import { translate } from '@/i18n/i18n'

type TaskSourcePlaneSetupProps = {
  connected: boolean
  checking: boolean
  visible: boolean
  onToggleVisible: () => void
  onOpenIntegrations: () => void
  canHide: boolean
}

// Keep connection, skill install, and visibility in the same guided flow.
export function TaskSourcePlaneSetup({
  connected,
  checking,
  visible,
  onToggleVisible,
  onOpenIntegrations,
  canHide
}: TaskSourcePlaneSetupProps): React.JSX.Element {
  const checkPlaneConnection = useAppStore((s) => s.checkPlaneConnection)
  const [dialogOpen, setDialogOpen] = useState(false)
  const skillSetup = usePlaneAgentSkillSetup()

  const connectState = checking ? 'in-progress' : connected ? 'done' : 'pending'
  const skillState = skillSetup.skillChecking
    ? 'in-progress'
    : skillSetup.skillInstalled
      ? 'done'
      : 'pending'
  const skillInstallBlocked = !connected && !skillSetup.skillInstalled && !skillSetup.skillChecking

  return (
    <>
      <ol className="divide-y divide-border/50">
        <TaskSourceStepRow
          index={1}
          state={connectState}
          title={translate(
            'auto.components.settings.TaskSourcePlaneSetup.connectTitle',
            'Connect Plane'
          )}
          description={translate(
            'auto.components.settings.TaskSourcePlaneSetup.connectDescription',
            'Add an API token so Orca can browse issues and open workspaces with ticket context.'
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
                    'auto.components.settings.TaskSourcePlaneSetup.manageAccess',
                    'Manage access'
                  )
                : translate(
                    'auto.components.settings.TaskSourcePlaneSetup.addAccess',
                    'Add Plane access'
                  )}
            </Button>
          }
        >
          {connected ? (
            <p className="text-[11px] text-muted-foreground">
              {translate(
                'auto.components.settings.TaskSourcePlaneSetup.connectedHint',
                'Workspaces and tokens are stored for the active runtime.'
              )}
            </p>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => void checkPlaneConnection()}
            >
              {translate(
                'auto.components.settings.TaskSourcePlaneSetup.recheck',
                'Re-check connection'
              )}
            </Button>
          )}
        </TaskSourceStepRow>

        <TaskSourceStepRow
          index={2}
          state={skillState}
          title={translate(
            'auto.components.settings.TaskSourcePlaneSetup.skillTitle',
            'Install Plane agent skill'
          )}
          description={translate(
            'auto.components.settings.TaskSourcePlaneSetup.skillDescription',
            'Gives agents /orca-plane to read tickets, post updates, move states, and comment on issues.'
          )}
          className={skillInstallBlocked ? 'opacity-60' : undefined}
        >
          {skillInstallBlocked ? (
            <p className="text-[11px] text-muted-foreground">
              {translate(
                'auto.components.settings.TaskSourcePlaneSetup.skillBlocked',
                'Connect Plane first, then install the skill for agents.'
              )}
            </p>
          ) : (
            <AgentSkillSetupPanel
              variant="inline"
              hideHeader
              title={translate(
                'auto.components.settings.TaskSourcePlaneSetup.skillPanelTitle',
                'Plane skill'
              )}
              description={null}
              skillNames={[ORCA_PLANE_SKILL_NAME]}
              installedSkillNames={[skillSetup.updateSkillName]}
              installed={skillSetup.skillInstalled}
              loading={skillSetup.skillLoading}
              error={skillSetup.error}
              installDisabled={skillSetup.installDisabled}
              onRecheck={skillSetup.refreshSkill}
              freshnessSkillName={skillSetup.freshnessSkillName}
            />
          )}
        </TaskSourceStepRow>

        <TaskSourceShowInTasksStep
          index={3}
          providerLabel={translate('auto.components.settings.TasksPane.plane', 'Plane')}
          visible={visible}
          canHide={canHide}
          onToggleVisible={onToggleVisible}
          description={translate(
            'auto.components.settings.TaskSourcePlaneSetup.showDescription',
            'Include Plane in the Tasks page source picker and sidebar shortcuts.'
          )}
        />
      </ol>

      <PlaneConnectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onConnected={() => {
          void checkPlaneConnection()
        }}
      />
    </>
  )
}
