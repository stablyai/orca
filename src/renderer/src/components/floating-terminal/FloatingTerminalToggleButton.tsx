import { TerminalSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { FloatingTerminalIconContextMenu } from './FloatingTerminalIconContextMenu'

export function FloatingTerminalToggleButton({
  open,
  onToggle
}: {
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  const shortcutLabel =
    typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac') ? '⌘⌥T' : 'Ctrl+Alt+T'
  return (
    <FloatingTerminalIconContextMenu
      currentLocation="floating-button"
      className="fixed bottom-8 right-3 z-40"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            className="border-border bg-secondary text-secondary-foreground shadow-xs hover:bg-accent hover:text-accent-foreground"
            data-floating-terminal-toggle
            aria-label={open ? 'Minimize floating terminal' : 'Show floating terminal'}
            aria-pressed={open}
            onClick={onToggle}
          >
            <TerminalSquare className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent
          side="left"
          sideOffset={6}
        >{`${open ? 'Minimize' : 'Show'} floating terminal (${shortcutLabel})`}</TooltipContent>
      </Tooltip>
    </FloatingTerminalIconContextMenu>
  )
}
