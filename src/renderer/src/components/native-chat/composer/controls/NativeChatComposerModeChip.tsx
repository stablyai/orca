import { X, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export function NativeChatComposerModeChip({
  icon: Icon,
  label,
  exitLabel,
  onExit,
  disabled
}: {
  icon: LucideIcon
  label: string
  exitLabel: string
  onExit: () => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="xs"
          aria-label={exitLabel}
          onClick={onExit}
          disabled={disabled}
          className="group/mode-chip"
        >
          <Icon
            aria-hidden
            className="group-hover/mode-chip:hidden group-focus-visible/mode-chip:hidden"
          />
          <X
            aria-hidden
            className="hidden group-hover/mode-chip:block group-focus-visible/mode-chip:block"
          />
          <span data-composer-label>{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {exitLabel}
      </TooltipContent>
    </Tooltip>
  )
}
