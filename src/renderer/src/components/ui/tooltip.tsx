import * as React from 'react'
import * as TooltipPrimitive from 'radix-ui/tooltip'

import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

function TooltipProvider({
  delayDuration = 0,
  disableHoverableContent = true,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  // Labels must not stay open through pointer hover and block the controls they describe.
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      disableHoverableContent={disableHoverableContent}
      {...props}
    />
  )
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

const TAB_PREVIEW_CLASSES =
  'w-64 max-w-[calc(100vw-1rem)] border border-border bg-popover p-3 text-popover-foreground shadow-floating motion-safe:animate-in motion-safe:fade-in-0 data-[state=closed]:animate-none'

const tooltipContentVariants = cva('z-[90] rounded-md text-xs', {
  variants: {
    variant: {
      default:
        'pointer-events-none w-fit origin-(--radix-tooltip-content-transform-origin) animate-in bg-foreground px-3 py-1.5 text-balance text-background fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
      'tab-preview': ['pointer-events-none', TAB_PREVIEW_CLASSES],
      // Why: a preview with its own controls takes the pointer; pair it with hoverable content.
      'tab-preview-interactive': TAB_PREVIEW_CLASSES
    }
  },
  defaultVariants: { variant: 'default' }
})

function TooltipContent({
  className,
  sideOffset = 0,
  showArrow = true,
  variant,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content> &
  VariantProps<typeof tooltipContentVariants> & { showArrow?: boolean; onPlaced?: () => void }) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        // Tooltip portals must layer above the menus/popovers that trigger them.
        className={cn(tooltipContentVariants({ variant }), className)}
        {...props}
      >
        {children}
        {showArrow ? (
          <TooltipPrimitive.Arrow className="size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground" />
        ) : null}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
