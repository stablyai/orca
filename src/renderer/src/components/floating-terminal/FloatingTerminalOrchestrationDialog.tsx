import { useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { AgentSkillSetupPanel } from '@/components/settings/AgentSkillSetupPanel'
import { IntegrationStatusPill } from '@/components/integration-status-pill'
import { ORCHESTRATION_SKILL_NAME } from '@/lib/agent-feature-install-commands'
import {
  AGENT_SKILL_CLI_PREREQUISITE_NOTICE,
  ensureOrcaCliAvailableForAgentSkillTerminal
} from '@/lib/agent-skill-cli-prerequisite'
import { ORCHESTRATION_SKILL_INSTALL_COMMAND } from '@/lib/orchestration-install-command'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  useInstalledAgentSkill
} from '@/hooks/useInstalledAgentSkills'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'

type FloatingTerminalOrchestrationDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSetupStateChange: () => void
}

export function FloatingTerminalOrchestrationDialog({
  open,
  onOpenChange,
  onSetupStateChange
}: FloatingTerminalOrchestrationDialogProps): React.JSX.Element {
  const {
    installed: orchestrationSkillDetected,
    loading: orchestrationSkillLoading,
    error: orchestrationSkillError,
    refresh: refreshOrchestrationSkill
  } = useInstalledAgentSkill(ORCHESTRATION_SKILL_NAME, {
    enabled: open,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })

  // Why: detecting the installed skill marks setup complete; refresh the banner
  // so it hides once the same quick-install flow used in Settings/CLI tips lands.
  useEffect(() => {
    if (orchestrationSkillDetected) {
      onSetupStateChange()
    }
  }, [orchestrationSkillDetected, onSetupStateChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-4 sm:max-w-[620px]">
        <DialogHeader>
          {/* Why: the panel renders with hideHeader, so the modal owns the title
              and status pill — avoiding a duplicate heading inside the modal. */}
          <div className="flex flex-wrap items-center gap-2 pr-6">
            <DialogTitle>{translate("auto.components.floating.terminal.FloatingTerminalOrchestrationDialog.543f325a14", "Enable orchestration")}</DialogTitle>
            {orchestrationSkillLoading && !orchestrationSkillDetected ? (
              <IntegrationStatusPill tone="neutral">{translate("auto.components.floating.terminal.FloatingTerminalOrchestrationDialog.dfd021ce46", "Checking...")}</IntegrationStatusPill>
            ) : orchestrationSkillDetected ? (
              <IntegrationStatusPill tone="connected">{translate("auto.components.floating.terminal.FloatingTerminalOrchestrationDialog.630c0ac8c8", "Installed")}</IntegrationStatusPill>
            ) : (
              <IntegrationStatusPill tone="attention">{translate("auto.components.floating.terminal.FloatingTerminalOrchestrationDialog.05d7aabc20", "Not installed")}</IntegrationStatusPill>
            )}
          </div>
          <DialogDescription className="sr-only">
            {translate("auto.components.floating.terminal.FloatingTerminalOrchestrationDialog.6f0aed26b8", "Install the Orca CLI and orchestration skill so agents can coordinate through Orca.")}</DialogDescription>
        </DialogHeader>

        <AgentSkillSetupPanel
          title={translate("auto.components.floating.terminal.FloatingTerminalOrchestrationDialog.1cd3f8af64", "Orchestration skill")}
          description={translate("auto.components.floating.terminal.FloatingTerminalOrchestrationDialog.f726054620", "Enables agents to hand off context and coordinate work through Orca.")}
          command={ORCHESTRATION_SKILL_INSTALL_COMMAND}
          terminalTitle="Orchestration setup"
          terminalAriaLabel="Orchestration skill install terminal"
          terminalWorktreeId="floating-terminal-orchestration-skill-terminal"
          installed={orchestrationSkillDetected}
          loading={orchestrationSkillLoading}
          error={orchestrationSkillError}
          variant="inline"
          hideHeader
          installLabel="Install CLI & skill"
          preInstallNotice={AGENT_SKILL_CLI_PREREQUISITE_NOTICE}
          onBeforeOpenTerminal={async () => {
            useAppStore.getState().recordFeatureInteraction('agent-orchestration-setup')
            await ensureOrcaCliAvailableForAgentSkillTerminal()
          }}
          onRecheck={refreshOrchestrationSkill}
        />
      </DialogContent>
    </Dialog>
  )
}
