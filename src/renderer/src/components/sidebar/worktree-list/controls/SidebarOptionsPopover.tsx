import React, { useCallback, useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverAnchor } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { OptionsFilterCountBadge } from './options-filter-count-badge'

/** A one-off note anchored to the options button; opening the menu dismisses it. */
export type SidebarOptionsHint = {
  open: boolean
  onDismiss: () => void
  content: React.ReactNode
}

/** A sidebar section's options button (sliders, filter-count badge) and the popover it opens. */
export function SidebarOptionsPopover({
  ariaLabel,
  tooltip,
  activeFilterCount,
  preserveWorkspaceBoardOpen = false,
  onMenuOpenChange,
  hint,
  children
}: {
  ariaLabel: string
  tooltip: string
  activeFilterCount: number
  preserveWorkspaceBoardOpen?: boolean
  onMenuOpenChange?: (open: boolean) => void
  hint?: SidebarOptionsHint
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const hintOpen = hint?.open === true
  const dismissHint = hint?.onDismiss
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next) {
        dismissHint?.()
      }
      setOpen(next)
      onMenuOpenChange?.(next)
    },
    [dismissHint, onMenuOpenChange]
  )
  const preserveOpen = preserveWorkspaceBoardOpen ? '' : undefined
  return (
    <Popover
      open={hintOpen}
      onOpenChange={(next) => {
        if (!next) {
          dismissHint?.()
        }
      }}
    >
      <DropdownMenu modal={false} open={open} onOpenChange={handleOpenChange}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <PopoverAnchor asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  type="button"
                  className="relative text-muted-foreground"
                  aria-label={ariaLabel}
                  data-workspace-board-preserve-open={preserveOpen}
                >
                  <SlidersHorizontal className="size-3.5" strokeWidth={2.25} />
                  <OptionsFilterCountBadge count={activeFilterCount} />
                </Button>
              </PopoverAnchor>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {tooltip}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          side="right"
          align="start"
          sideOffset={8}
          className="w-72 pb-2"
          data-workspace-board-preserve-open={preserveOpen}
        >
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
      {hintOpen ? hint?.content : null}
    </Popover>
  )
}
