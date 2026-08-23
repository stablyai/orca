import { Copy } from 'lucide-react'
import { OnboardingInlineCommandTerminal } from '../onboarding/OnboardingInlineCommandTerminal'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import type { SkillTerminalSnapshot } from './agent-skill-terminal-snapshot'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

type AgentSkillSetupCommandTerminalProps = {
  command: string
  onCommandFinished: (exitCode: number | null) => void
  onCopy: () => void
  onTerminalExit: () => void
  snapshot: SkillTerminalSnapshot
  terminalAriaLabel: string
  terminalAttempt: number
  terminalHeightPx?: number
  terminalTitle: string
  terminalWorktreeId: string
  variant: 'card' | 'inline'
}

export function AgentSkillSetupCommandTerminal({
  command,
  onCommandFinished,
  onCopy,
  onTerminalExit,
  snapshot,
  terminalAriaLabel,
  terminalAttempt,
  terminalHeightPx,
  terminalTitle,
  terminalWorktreeId,
  variant
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
          {command}
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
        command={command}
        prepareCommandForShell={snapshot.prepareCommandForShell}
        title={terminalTitle}
        description={translate(
          'auto.components.settings.AgentSkillSetupPanel.runCommandDescription',
          'Press Enter to run the command.'
        )}
        ariaLabel={terminalAriaLabel}
        terminalHeightPx={terminalHeightPx}
        shellOverride={snapshot.shellOverride}
        forceHostRuntime={snapshot.forceHostRuntime}
        runtimeEnvironmentId={snapshot.runtimeEnvironmentId}
        terminalTopMarginPx={8}
        descriptionPaddingClassName="px-4 py-2"
        autoScrollIntoView={false}
        onTerminalExit={onTerminalExit}
        onCommandFinished={onCommandFinished}
      />
    </div>
  )
}
