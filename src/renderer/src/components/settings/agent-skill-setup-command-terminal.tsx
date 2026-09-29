import { Copy } from 'lucide-react'
import { OnboardingInlineCommandTerminal } from '../onboarding/OnboardingInlineCommandTerminal'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { SkillTerminalSnapshot } from './agent-skill-terminal-snapshot'

type AgentSkillSetupCommandTerminalProps = {
  variant: 'card' | 'inline'
  previewCommand: string
  executeCommand: string
  terminalSnapshot: SkillTerminalSnapshot
  terminalAttempt: number
  terminalWorktreeId: string
  terminalTitle: string
  terminalAriaLabel: string
  terminalHeightPx?: number
  onCopy: () => void
  onTerminalExit: () => void
  onCommandFinished: (bestEffortExitCode: number | null) => void
}

export function AgentSkillSetupCommandTerminal({
  variant,
  previewCommand,
  executeCommand,
  terminalSnapshot,
  terminalAttempt,
  terminalWorktreeId,
  terminalTitle,
  terminalAriaLabel,
  terminalHeightPx,
  onCopy,
  onTerminalExit,
  onCommandFinished
}: AgentSkillSetupCommandTerminalProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'min-w-0 max-w-full overflow-hidden',
        variant === 'card' ? 'px-5 pb-5' : 'mt-2'
      )}
    >
      <div className="flex min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-md border border-border bg-muted/35 px-3 py-2">
        <code className="scrollbar-sleek min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-muted-foreground">
          {previewCommand}
        </code>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              aria-label={translate(
                'auto.components.settings.AgentSkillSetupPanel.copyCommandAria',
                'Copy command'
              )}
              onClick={onCopy}
            >
              <Copy className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {translate('auto.components.settings.AgentSkillSetupPanel.ed197f59a2', 'Copy command')}
          </TooltipContent>
        </Tooltip>
      </div>
      <OnboardingInlineCommandTerminal
        key={terminalAttempt}
        worktreeId={terminalWorktreeId}
        command={executeCommand}
        prepareCommandForShell={terminalSnapshot.prepareCommandForShell}
        title={terminalTitle}
        description={translate(
          'auto.components.settings.AgentSkillSetupPanel.runCommandDescription',
          'Press Enter to run the command.'
        )}
        ariaLabel={terminalAriaLabel}
        terminalHeightPx={terminalHeightPx}
        shellOverride={terminalSnapshot.shellOverride}
        terminalTopMarginPx={8}
        descriptionPaddingClassName="px-4 py-2"
        autoScrollIntoView={false}
        onTerminalExit={onTerminalExit}
        onCommandFinished={onCommandFinished}
      />
    </div>
  )
}
