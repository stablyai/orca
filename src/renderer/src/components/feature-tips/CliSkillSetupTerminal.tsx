import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { OnboardingInlineCommandTerminal } from '@/components/onboarding/OnboardingInlineCommandTerminal'
import { ORCA_CLI_ORCHESTRATION_SKILL_INSTALL_COMMAND } from '@/lib/agent-feature-install-commands'

export function CliSkillSetupTerminal(): React.JSX.Element {
  const handleCopySkillCommand = async (): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(ORCA_CLI_ORCHESTRATION_SKILL_INSTALL_COMMAND)
      toast.success('Copied the skill install command.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to copy skill command.')
    }
  }

  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted/35 px-3 py-2">
        <code className="scrollbar-sleek min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-muted-foreground">
          {ORCA_CLI_ORCHESTRATION_SKILL_INSTALL_COMMAND}
        </code>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              onClick={() => void handleCopySkillCommand()}
              aria-label="Copy skill install command"
            >
              <Copy className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            Copy command
          </TooltipContent>
        </Tooltip>
      </div>
      <OnboardingInlineCommandTerminal
        command={ORCA_CLI_ORCHESTRATION_SKILL_INSTALL_COMMAND}
        title="Skill setup"
        ariaLabel="Orca CLI and orchestration skill install terminal"
        description="Press Enter to install the Orca CLI orchestration skill for your agents."
        terminalHeightPx={280}
        terminalTopMarginPx={8}
        descriptionPaddingClassName="px-4 py-2"
        autoScrollIntoView={false}
        worktreeId="feature-tip-cli-skills-terminal"
      />
    </div>
  )
}
