import { PanelsTopLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { FloatingTerminalIconContextMenu } from './FloatingTerminalIconContextMenu'

export function FloatingTerminalToggleButton({
  open,
  onToggle,
  className
}: {
  open: boolean
  onToggle: () => void
  className?: string
}): React.JSX.Element {
  const shortcutLabel =
    typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac') ? '⌘⌥T' : 'Ctrl+Alt+T'
  return (
    <FloatingTerminalIconContextMenu
      currentLocation="floating-button"
      className={cn('fixed bottom-3 right-3 z-40', className)}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            className="border-border bg-secondary text-secondary-foreground shadow-xs hover:bg-accent hover:text-accent-foreground"
            data-floating-terminal-toggle
            aria-label={open ? 'Minimize floating workspace' : 'Show floating workspace'}
            aria-pressed={open}
            onClick={onToggle}
          >
            <PanelsTopLeft className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent
          side="left"
          sideOffset={6}
        >{`${open ? 'Minimize' : 'Show'} floating workspace (${shortcutLabel})`}</TooltipContent>
      </Tooltip>
    </FloatingTerminalIconContextMenu>
  )
}
