import React from 'react'

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

export type OdooTicketFilterOption = {
  value: string
  label: React.ReactNode
}

/**
 * Identifies which filter menu owns the toolbar's single open slot. `null`
 * means every menu is closed.
 */
export type OdooTicketFilterId = string | null

/**
 * One filter dropdown in the Odoo ticket toolbar.
 *
 * Why controlled: the ticket detail Sheet is non-modal with a click-through
 * overlay, which defeats Radix's own outside-pointer bookkeeping and let
 * several filter menus sit open on top of each other. Routing every menu
 * through one `openFilter` slot makes the exclusion explicit instead.
 */
export function OdooTicketFilterSelect({
  id,
  openFilter,
  onOpenFilterChange,
  value,
  onValueChange,
  options,
  triggerClassName,
  disabled
}: {
  id: string
  openFilter: OdooTicketFilterId
  onOpenFilterChange: (next: OdooTicketFilterId) => void
  value: string
  onValueChange: (next: string) => void
  options: OdooTicketFilterOption[]
  triggerClassName?: string
  disabled?: boolean
}): React.JSX.Element {
  return (
    <Select
      open={openFilter === id}
      onOpenChange={(next) => onOpenFilterChange(next ? id : null)}
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
    >
      <SelectTrigger className={cn('h-7 text-xs', triggerClassName)}>
        <SelectValue />
      </SelectTrigger>
      {/* Why: the default item-aligned position draws the menu over its own
          trigger and spills onto the neighbouring filters; popper/start anchors
          each menu under the trigger it belongs to. */}
      <SelectContent position="popper" align="start">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
