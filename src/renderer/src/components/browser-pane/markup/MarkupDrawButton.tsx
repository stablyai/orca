import React from 'react'
import { PenTool } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

export type MarkupDrawButtonProps = {
  onClick: () => void
  disabled?: boolean
  active?: boolean
  className?: string
}

// Toolbar toggle that enters screenshot-markup mode. Shared by the local and
// remote browser panes so both expose the same affordance.
export function MarkupDrawButton({
  onClick,
  disabled,
  active,
  className
}: MarkupDrawButtonProps): React.JSX.Element {
  const label = translate('auto.components.browser-pane.markup.drawButton', 'Draw on screenshot')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Why: wrap in a span so tooltip hover still fires when disabled. */}
        <span className="inline-flex">
          <Button
            size="icon"
            variant={active ? 'default' : 'ghost'}
            className={cn(
              className ?? 'h-8 w-8',
              active && 'bg-foreground/80 text-background hover:bg-foreground/90'
            )}
            onClick={onClick}
            disabled={disabled}
            aria-label={label}
            aria-pressed={active}
          >
            <PenTool className="size-4" />
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
