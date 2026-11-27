import React from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu'
import {
  refocusTriggerIfFocusLost,
  useMenuHeldInPlace,
  type AppRailCustomizeRow
} from './app-rail-menu-focus'

/** One checkbox row per rail page; toggling keeps the menu open so several can change in one visit. */
export function AppRailCustomizeRows({
  rows
}: {
  rows: readonly AppRailCustomizeRow[]
}): React.JSX.Element {
  return (
    <>
      {rows.map((row) => (
        <DropdownMenuItem
          key={row.id}
          role="menuitemcheckbox"
          aria-checked={row.shown}
          onSelect={(event) => {
            event.preventDefault()
            row.onToggle()
          }}
        >
          {row.icon}
          <span className="min-w-0 flex-1 truncate">{row.label}</span>
          <Check
            className={cn('size-3.5 text-muted-foreground', !row.shown && 'invisible')}
            aria-hidden
          />
        </DropdownMenuItem>
      ))}
    </>
  )
}

export function AppRailCustomizeMenuContent({
  open,
  rows,
  triggerRef
}: {
  open: boolean
  rows: readonly AppRailCustomizeRow[]
  triggerRef: React.RefObject<HTMLButtonElement | null>
}): React.JSX.Element {
  const heldInPlace = useMenuHeldInPlace(open, triggerRef, rows)
  return (
    <DropdownMenuContent
      side="right"
      align="start"
      sideOffset={8}
      {...heldInPlace}
      onCloseAutoFocus={() => refocusTriggerIfFocusLost(triggerRef.current)}
    >
      <AppRailCustomizeRows rows={rows} />
    </DropdownMenuContent>
  )
}
