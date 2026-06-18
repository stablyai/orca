import type { ComponentProps } from 'react'
import { CheckCircle2, Info } from 'lucide-react'
import { IntegrationStatusPill } from '@/components/integration-status-pill'
import { AgentSkillSetupPanel } from '@/components/settings/AgentSkillSetupPanel'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  AGENT_SKILL_CLI_PREREQUISITE_NOTICE,
  isOrcaCliAvailableOnPath
} from '@/lib/agent-skill-cli-prerequisite'
import { translate } from '@/i18n/i18n'

type AgentSkillSetupPanelProps = ComponentProps<typeof AgentSkillSetupPanel>

type LinearAgentSkillSetupDialogProps = {
  open: boolean
  showSuccess: boolean
  successDescription: string
  missingLabel: string
  command: string
  terminalShellOverride?: string
  installed: boolean
  loading: boolean
  error: string | null
  getPrerequisiteStatus?: AgentSkillSetupPanelProps['getPrerequisiteStatus']
  onBeforeOpenTerminal: AgentSkillSetupPanelProps['onBeforeOpenTerminal']
  onRecheck: AgentSkillSetupPanelProps['onRecheck']
  onOpenChange: (open: boolean) => void
  onDismissPermanently: () => void
  onSnoozeForSession: () => void
  onDone: () => void
}

export function LinearAgentSkillSetupDialog({
  open,
  showSuccess,
  successDescription,
  missingLabel,
  command,
  terminalShellOverride,
  installed,
  loading,
  error,
  getPrerequisiteStatus,
  onBeforeOpenTerminal,
  onRecheck,
  onOpenChange,
  onDismissPermanently,
  onSnoozeForSession,
  onDone
}: LinearAgentSkillSetupDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[640px]">
        {showSuccess ? (
          <>
            <div className="px-6 pt-6 pr-14">
              <DialogHeader className="gap-2">
                <DialogTitle>
                  {translate(
                    'auto.components.sidebar.LinearAgentSkillSetupPrompt.successTitle',
                    'Linear ticket access is ready'
                  )}
                </DialogTitle>
                <DialogDescription>{successDescription}</DialogDescription>
              </DialogHeader>
              <div className="mt-4 flex items-center gap-2">
                <CheckCircle2 className="size-4 shrink-0 text-muted-foreground" />
                <IntegrationStatusPill tone="connected">
                  {translate(
                    'auto.components.sidebar.LinearAgentSkillSetupPrompt.successStatus',
                    'Linear ticket access ready'
                  )}
                </IntegrationStatusPill>
              </div>
            </div>
            <DialogFooter className="px-6 pt-5 pb-6">
              <Button type="button" size="sm" onClick={onDone}>
                {translate('auto.components.sidebar.LinearAgentSkillSetupPrompt.done', 'Done')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="px-6 pt-6 pr-14">
              <DialogHeader>
                <DialogTitle className="sr-only">
                  {translate(
                    'auto.components.sidebar.LinearAgentSkillSetupPrompt.modalTitle',
                    'Enable Linear ticket access'
                  )}
                </DialogTitle>
                <DialogDescription className="sr-only">
                  {translate(
                    'auto.components.sidebar.LinearAgentSkillSetupPrompt.modalDescription',
                    'Install the Linear skill from a terminal.'
                  )}
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-start gap-2 text-base font-semibold leading-snug text-foreground">
                <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <p>
                  {translate(
                    'auto.components.sidebar.LinearAgentSkillSetupPrompt.modalPrompt',
                    'Enable agents to read and edit the attached Linear ticket.'
                  )}
                </p>
              </div>
            </div>
            <AgentSkillSetupPanel
              className="px-6 pt-4 pb-3"
              variant="inline"
              hideHeader
              title={translate(
                'auto.components.sidebar.LinearAgentSkillSetupPrompt.modalTitle',
                'Enable Linear ticket access'
              )}
              description={missingLabel}
              command={command}
              terminalTitle={translate(
                'auto.components.sidebar.LinearAgentSkillSetupPrompt.terminalTitle',
                'Install Linear agent skill'
              )}
              terminalAriaLabel={translate(
                'auto.components.sidebar.LinearAgentSkillSetupPrompt.terminalAria',
                'Linear agent skill installer terminal'
              )}
              terminalWorktreeId="sidebar-linear-agent-skill-setup"
              terminalHeightPx={240}
              terminalShellOverride={terminalShellOverride}
              installed={installed}
              loading={loading}
              error={error}
              installLabel={translate(
                'auto.components.sidebar.LinearAgentSkillSetupPrompt.install',
                'Install CLI & Skill'
              )}
              preInstallNotice={AGENT_SKILL_CLI_PREREQUISITE_NOTICE}
              getPrerequisiteStatus={getPrerequisiteStatus}
              isPrerequisiteAvailable={isOrcaCliAvailableOnPath}
              onBeforeOpenTerminal={onBeforeOpenTerminal}
              onRecheck={onRecheck}
            />
            <DialogFooter className="px-6 pb-6">
              <Button type="button" variant="ghost" size="sm" onClick={onDismissPermanently}>
                {translate(
                  'auto.components.sidebar.LinearAgentSkillSetupPrompt.dontShowAgain',
                  "Don't show again"
                )}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={onSnoozeForSession}>
                {translate('auto.components.sidebar.LinearAgentSkillSetupPrompt.notNow', 'Not now')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
