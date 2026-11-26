import type React from 'react'
import { cn } from '@/lib/class-names'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'

export function ToggleButton({
  active,
  onClick,
  title,
  children,
  ariaExpanded
}: {
  /** Omit for a plain action, such as Clear. */
  active?: boolean
  onClick: () => void
  title: string
  children: React.ReactNode
  ariaExpanded?: boolean
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={cn(
            'h-auto w-auto rounded-sm p-0.5 flex-shrink-0',
            active
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted'
          )}
          onClick={onClick}
          aria-label={title}
          aria-pressed={active}
          aria-expanded={ariaExpanded}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {title}
      </TooltipContent>
    </Tooltip>
  )
}
