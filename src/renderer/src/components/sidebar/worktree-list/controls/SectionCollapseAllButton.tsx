import React from 'react'
import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ShortcutKeyCombo } from '@/components/ui/ShortcutKeyCombo'
import type { ShortcutKeyComboDetails } from '@/lib/keyboard/useShortcutLabel'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'

/** A section header's collapse-all toggle, shown while the header is hovered or holds focus. */
export function SectionCollapseAllButton({
  allCollapsed,
  onToggle,
  collapseLabel,
  expandLabel,
  shortcut,
  announcing = false,
  toggleAttributes
}: {
  allCollapsed: boolean
  onToggle: () => void
  collapseLabel: string
  expandLabel: string
  /** Shown in the tooltip; omitted when the action has no shortcut. */
  shortcut?: ShortcutKeyComboDetails
  /** A tour points at it, so it stays shown without hover. */
  announcing?: boolean
  /** Marks the wrapper for tours and tests, e.g. `{ 'data-projects-collapse-toggle': '' }`. */
  toggleAttributes?: Record<`data-${string}`, string>
}): React.JSX.Element {
  const label = allCollapsed ? expandLabel : collapseLabel
  const Icon = allCollapsed ? ChevronsUpDown : ChevronsDownUp

  // Own provider so a tooltip open on a neighbor can't skip this delay; clicks are the common case.
  return (
    <TooltipProvider delayDuration={1000} skipDelayDuration={0}>
      <Tooltip>
        <span
          {...toggleAttributes}
          className={cn(
            'flex shrink-0 overflow-hidden text-muted-foreground',
            'can-hover:w-0 can-hover:opacity-0',
            'can-hover:group-hover/sidebar-header:w-6 can-hover:group-hover/sidebar-header:opacity-100',
            'can-hover:focus-within:w-6 can-hover:focus-within:opacity-100',
            announcing && 'can-hover:w-6 can-hover:opacity-100'
          )}
        >
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              aria-label={label}
              onClick={onToggle}
            >
              <Icon />
            </Button>
          </TooltipTrigger>
        </span>
        <TooltipContent side="top" sideOffset={4}>
          <span className="flex items-center gap-2">
            {label}
            {shortcut ? <ShortcutKeyCombo {...shortcut} /> : null}
          </span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
