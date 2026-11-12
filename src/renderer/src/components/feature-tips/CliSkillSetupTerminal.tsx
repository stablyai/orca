// COMPAT(wsl-bridge): removed when WSL runs as an orcad host.
import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { OnboardingInlineCommandTerminal } from '@/components/onboarding/OnboardingInlineCommandTerminal'
import {
  buildSkillCommandForRuntime,
  buildSkillSetupTerminalCommand
} from '@/lib/skills/runtime/skill-runtime-command'
import { ORCA_CLI_ORCHESTRATION_SKILL_INSTALL_COMMAND } from '@/lib/skills/installation/agent-feature-install-commands'
import { useActiveProjectSkillRuntime } from '@/hooks/skills/runtime/useActiveProjectSkillRuntime'
import { useTranslate } from '@/i18n/use-translate'

export function CliSkillSetupTerminal(): React.JSX.Element {
  const t = useTranslate()
  const activeSkillRuntime = useActiveProjectSkillRuntime()
  // Missing WSL distros fall back to the Windows host; this ungated auto-paste still needs npx preflight.
  const skillCommand = buildSkillCommandForRuntime(
    ORCA_CLI_ORCHESTRATION_SKILL_INSTALL_COMMAND,
    activeSkillRuntime.installDisabledReason ? undefined : activeSkillRuntime.agentRuntime
  )
  const terminalRuntime = activeSkillRuntime.installDisabledReason
    ? undefined
    : activeSkillRuntime.agentRuntime
  const prepareCommandForShell = (command: string, effectiveShell: string | undefined): string =>
    buildSkillSetupTerminalCommand(command, effectiveShell, terminalRuntime)
  const handleCopySkillCommand = async (): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(skillCommand)
      toast.success(
        t(
          'auto.components.feature.tips.CliSkillSetupTerminal.b8ad063571',
          'Copied the skill install command.'
        )
      )
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t(
              'auto.components.feature.tips.CliSkillSetupTerminal.6ff813fc1d',
              'Failed to copy skill command.'
            )
      )
    }
  }

  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted/35 px-3 py-2">
        <code className="scrollbar-sleek min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-muted-foreground">
          {skillCommand}
        </code>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              onClick={() => void handleCopySkillCommand()}
              aria-label={t(
                'auto.components.feature.tips.CliSkillSetupTerminal.5eca672aac',
                'Copy skill install command'
              )}
            >
              <Copy className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {t('auto.components.feature.tips.CliSkillSetupTerminal.5c3aee22c0', 'Copy command')}
          </TooltipContent>
        </Tooltip>
      </div>
      <OnboardingInlineCommandTerminal
        command={skillCommand}
        prepareCommandForShell={prepareCommandForShell}
        title={t('auto.components.feature.tips.CliSkillSetupTerminal.84e9576dac', 'Skill setup')}
        ariaLabel={t(
          'auto.components.feature.tips.CliSkillSetupTerminal.43b60ec5c3',
          'Orca CLI and orchestration skill install terminal'
        )}
        description={t(
          'auto.components.feature.tips.CliSkillSetupTerminal.1953e90447',
          'Press Enter to install the Orca CLI orchestration skill for your agents.'
        )}
        terminalHeightPx={280}
        terminalTopMarginPx={8}
        descriptionPaddingClassName="px-4 py-2"
        autoScrollIntoView={false}
        worktreeId="feature-tip-cli-skills-terminal"
        shellOverride={activeSkillRuntime.terminalShellOverride}
        forceHostRuntime={Boolean(activeSkillRuntime.installDisabledReason)}
      />
    </div>
  )
}
