import { TerminalSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

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
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          className="fixed bottom-8 right-3 z-40 bg-card/95 shadow-xs"
          data-floating-terminal-toggle
          aria-label={open ? 'Hide floating terminal' : 'Show floating terminal'}
          aria-pressed={open}
          onClick={onToggle}
        >
          <TerminalSquare className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent
        side="left"
        sideOffset={6}
      >{`${open ? 'Hide' : 'Show'} floating terminal (${shortcutLabel})`}</TooltipContent>
    </Tooltip>
  )
}
