import { Copy } from 'lucide-react'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { StepBadge } from './BrowserUseStepBadge'

type Props = {
  command: string
  skillInstalled: boolean
  disabled?: boolean
  onCopy: () => void
  onToggleInstalled: () => void
}

export function BrowserUseSkillStep({
  command,
  skillInstalled,
  disabled = false,
  onCopy,
  onToggleInstalled
}: Props): React.JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <StepBadge index={2} state={skillInstalled ? 'done' : 'pending'} />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="space-y-1">
          <p className="text-sm font-medium">Install Browser Use Skill</p>
          <p className="text-xs text-muted-foreground">
            Run this once on your computer so Claude Code, Codex, and other agents learn to drive
            Orca&apos;s browser.
          </p>
        </div>
        <div className="flex max-w-full items-center gap-2 rounded-lg border border-border/60 bg-background/60 px-3 py-2">
          <code className="flex-1 overflow-x-auto whitespace-nowrap text-[11px] text-muted-foreground">
            {command}
          </code>
          <TooltipProvider delayDuration={250}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={onCopy}
                  aria-label="Copy skill install command"
                >
                  <Copy className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                Copy
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>
            {skillInstalled
              ? 'Marked as installed on this machine.'
              : "Check off once you've run it on this computer."}
          </span>
          <button
            type="button"
            className="underline-offset-2 hover:text-foreground hover:underline disabled:cursor-not-allowed disabled:no-underline disabled:hover:text-muted-foreground"
            onClick={onToggleInstalled}
            disabled={disabled}
          >
            {skillInstalled ? 'Undo' : 'I ran it'}
          </button>
        </div>
      </div>
    </div>
  )
}
