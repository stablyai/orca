import React, { useRef, useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import {
  refocusTriggerIfFocusLost,
  useAppRailCustomizeLabel,
  useMenuHeldInPlace,
  type AppRailCustomizeRow
} from './app-rail-menu-focus'
import { AppRailCustomizeRows } from './AppRailCustomizeMenuContent'

export type AppRailMoreDestination = {
  id: string
  label: string
  icon: React.ReactNode
  current: boolean
  /** The page moves focus itself when it opens (Automations' title), so the menu must not refocus its trigger. */
  ownsFocusOnOpen?: boolean
  onSelect: () => void
}

export function AppRailMoreMenuContent({
  destinations,
  customizeRows,
  triggerRef
}: {
  destinations: readonly AppRailMoreDestination[]
  customizeRows: readonly AppRailCustomizeRow[]
  triggerRef: React.RefObject<HTMLButtonElement | null>
}): React.JSX.Element {
  // Why: Radix refocuses the trigger in a timeout after closing, which would land after (or before, on a cold page
  // load) the page's own focus; yielding makes the page's focus win every time.
  const yieldCloseFocusRef = useRef(false)
  const customizeLabel = useAppRailCustomizeLabel()
  const customizeTriggerRef = useRef<HTMLDivElement>(null)
  const [customizeOpen, setCustomizeOpen] = useState(false)
  // Toggling a page on while folded adds a row above Customize; keep its submenu put.
  const customizeHeldInPlace = useMenuHeldInPlace(customizeOpen, customizeTriggerRef, customizeRows)

  return (
    <DropdownMenuContent
      side="right"
      align="start"
      sideOffset={8}
      className="w-52"
      onCloseAutoFocus={(event) => {
        if (yieldCloseFocusRef.current) {
          yieldCloseFocusRef.current = false
          event.preventDefault()
        } else {
          refocusTriggerIfFocusLost(triggerRef.current)
        }
      }}
    >
      {destinations.map((destination) => (
        <DropdownMenuItem
          key={destination.id}
          onSelect={() => {
            yieldCloseFocusRef.current = destination.ownsFocusOnOpen === true
            destination.onSelect()
          }}
          aria-current={destination.current ? 'page' : undefined}
        >
          {destination.icon}
          {destination.label}
        </DropdownMenuItem>
      ))}
      {destinations.length > 0 ? <DropdownMenuSeparator /> : null}
      <DropdownMenuSub open={customizeOpen} onOpenChange={setCustomizeOpen}>
        <DropdownMenuSubTrigger ref={customizeTriggerRef}>
          <SlidersHorizontal className="size-3.5" aria-hidden />
          {customizeLabel}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent scrollable {...customizeHeldInPlace}>
          <AppRailCustomizeRows rows={customizeRows} />
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </DropdownMenuContent>
  )
}
