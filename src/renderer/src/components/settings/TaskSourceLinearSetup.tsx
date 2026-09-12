import { useState } from 'react'
import { LinearApiKeyDialog } from '@/components/linear-api-key-dialog'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'
import { TaskSourceShowInTasksStep } from './TaskSourceShowInTasksStep'
import { TaskSourceStepRow } from './TaskSourceStepRow'
import { useLinearAgentSkillSetup } from './use-linear-agent-skill-setup'
import { translate } from '@/i18n/i18n'

type TaskSourceLinearSetupProps = {
  connected: boolean
  checking: boolean
  visible: boolean
  onToggleVisible: () => void
  onOpenIntegrations: () => void
  canHide: boolean
}

// Keep connection, skill install, and visibility in the same guided flow.
export function TaskSourceLinearSetup({
  connected,
  checking,
  visible,
  onToggleVisible,
  onOpenIntegrations,
  canHide
}: TaskSourceLinearSetupProps): React.JSX.Element {
  const checkLinearConnection = useAppStore((s) => s.checkLinearConnection)
  const [dialogOpen, setDialogOpen] = useState(false)
  const skillSetup = useLinearAgentSkillSetup()

  const connectState = checking ? 'in-progress' : connected ? 'done' : 'pending'
  // Skill install is independent of API connection; only gate the first-time install CTA.
  const skillState = skillSetup.skillChecking
    ? 'in-progress'
    : skillSetup.skillInstalled
      ? 'done'
      : 'pending'
  // Keep the panel visible while scanning so we don't flash "connect first" over an installed skill.
  const skillInstallBlocked = !connected && !skillSetup.skillInstalled && !skillSetup.skillChecking

  return (
    <>
      <ol className="divide-y divide-border/50">
        <TaskSourceStepRow
          index={1}
          state={connectState}
          title={translate(
            'auto.components.settings.TaskSourceLinearSetup.connectTitle',
            'Connect Linear'
          )}
          description={translate(
            'auto.components.settings.TaskSourceLinearSetup.connectDescription',
            'Add a Personal API key so Orca can browse issues and open workspaces with ticket context.'
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
                    'auto.components.settings.TaskSourceLinearSetup.manageAccess',
                    'Manage keys'
                  )
                : translate(
                    'auto.components.settings.TaskSourceLinearSetup.addAccess',
                    'Add Linear access'
                  )}
            </Button>
          }
        >
          {connected ? (
            <p className="text-[11px] text-muted-foreground">
              {translate(
                'auto.components.settings.TaskSourceLinearSetup.connectedHint',
                'Workspaces and keys are stored for the active runtime. You can add more access any time.'
              )}
            </p>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => void checkLinearConnection(true)}
            >
              {translate(
                'auto.components.settings.TaskSourceLinearSetup.recheck',
                'Re-check connection'
              )}
            </Button>
          )}
        </TaskSourceStepRow>

        <TaskSourceStepRow
          index={2}
          state={skillState}
          title={translate(
            'auto.components.settings.TaskSourceLinearSetup.skillTitle',
            'Install Linear agent skill'
          )}
          description={translate(
            'auto.components.settings.TaskSourceLinearSetup.skillDescription',
            'Gives agents /orca-linear to read tickets, post updates, move states, and attach pull or merge requests.'
          )}
          className={skillInstallBlocked ? 'opacity-60' : undefined}
        >
          {skillInstallBlocked ? (
            <p className="text-[11px] text-muted-foreground">
              {translate(
                'auto.components.settings.TaskSourceLinearSetup.skillBlocked',
                'Connect Linear first, then install the skill for agents.'
              )}
            </p>
          ) : (
            <AgentSkillSetupPanel
              variant="inline"
              hideHeader
              title={translate(
                'auto.components.settings.TaskSourceLinearSetup.skillPanelTitle',
                'Linear skill'
              )}
              description={null}
              command={skillSetup.installCommand}
              installedCommand={skillSetup.updateCommand}
              terminalTitle={translate(
                'auto.components.settings.TaskSourceLinearSetup.terminalTitle',
                'Linear skill setup'
              )}
              terminalAriaLabel={translate(
                'auto.components.settings.TaskSourceLinearSetup.terminalAriaLabel',
                'Linear skill install terminal'
              )}
              terminalWorktreeId="settings-tasks-linear-skill-terminal"
              terminalShellOverride={skillSetup.terminalShellOverride}
              terminalRuntime={skillSetup.terminalRuntime}
              installed={skillSetup.skillInstalled}
              loading={skillSetup.skillLoading}
              error={skillSetup.error}
              installDisabled={skillSetup.installDisabled}
              preInstallNotice={skillSetup.preInstallNotice}
              getPrerequisiteStatus={skillSetup.getPrerequisiteStatus}
              onBeforeOpenTerminal={skillSetup.onBeforeOpenTerminal}
              onRecheck={skillSetup.refreshSkill}
              freshnessSkillName={skillSetup.freshnessSkillName}
            />
          )}
        </TaskSourceStepRow>

        <TaskSourceShowInTasksStep
          index={3}
          providerLabel={translate('auto.components.settings.TasksPane.09ae2d7c51', 'Linear')}
          visible={visible}
          canHide={canHide}
          onToggleVisible={onToggleVisible}
          description={translate(
            'auto.components.settings.TaskSourceLinearSetup.showDescription',
            'Include Linear in the Tasks page source picker and sidebar shortcuts.'
          )}
        />
      </ol>

      <LinearApiKeyDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        connectLabel={translate(
          'auto.components.settings.TaskSourceLinearSetup.addAccess',
          'Add Linear access'
        )}
        onConnected={() => {
          void checkLinearConnection(true)
        }}
      />
    </>
  )
}
