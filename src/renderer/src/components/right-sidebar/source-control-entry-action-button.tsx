import React from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export function ActionButton({
  icon: Icon,
  title,
  onClick,
  disabled
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  onClick: (event: React.MouseEvent) => void
  disabled?: boolean
}): React.JSX.Element {
  // Why: use the Radix Tooltip instead of the native `title` attribute so the
  // label matches the rest of the sidebar chrome (consistent styling, no OS
  // delay quirks, dismissible on pointer leave).
  //
  // Why (no local TooltipProvider): the app root mounts a single
  // TooltipProvider (see App.tsx); nesting another one here gives this subtree
  // its own delay-timing state and breaks Radix's "skip the open delay when
  // moving between adjacent tooltip triggers" handoff between sibling action
  // buttons in the section header.
  //
  // Why (disabled handling): Radix's TooltipTrigger asChild on a disabled
  // <button> gets pointer-events blocked in Chromium, which suppresses the
  // tooltip entirely — a regression vs. the native `title` attribute it
  // replaced. We keep the button interactive and rely on the caller's
  // `isExecutingBulk` early-return to no-op the click during bulk ops;
  // `aria-disabled` + visual dimming preserves the disabled affordance.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={cn(
            'text-muted-foreground hover:bg-background/70 hover:text-foreground',
            disabled && 'opacity-50 cursor-not-allowed'
          )}
          aria-label={title}
          aria-disabled={disabled}
          onClick={(event) => {
            if (disabled) {
              event.preventDefault()
              return
            }
            onClick(event)
          }}
        >
          <Icon className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {title}
      </TooltipContent>
    </Tooltip>
  )
}
