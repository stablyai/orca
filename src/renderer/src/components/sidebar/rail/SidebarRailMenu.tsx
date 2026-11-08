import React from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { KeybindingActionId } from '../../../../../shared/keybindings'
import { SidebarRailTooltip, sidebarRailButtonClassName } from '../sidebar-rail-control'

type SidebarRailMenuProps = {
  icon: React.ReactNode
  label: string
  badge?: React.ReactNode
  align: 'start' | 'end'
  hint?: string
  shortcutActionId?: KeybindingActionId
  triggerProps?: Record<`data-${string}`, string | undefined>
  contentProps?: Record<`data-${string}`, string | undefined>
  onOpenChange?: (open: boolean) => void
  children: React.ReactNode
}

export function SidebarRailMenu({
  icon,
  label,
  badge,
  align,
  hint,
  shortcutActionId,
  triggerProps,
  contentProps,
  onOpenChange,
  children
}: SidebarRailMenuProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false)

  const handleOpenChange = (next: boolean): void => {
    setOpen(next)
    onOpenChange?.(next)
  }

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={handleOpenChange}>
      <SidebarRailTooltip
        label={hint ?? label}
        shortcutActionId={hint ? undefined : shortcutActionId}
        open={open ? false : hint ? true : undefined}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={label}
            className={sidebarRailButtonClassName(open)}
            {...triggerProps}
          >
            {icon}
            {badge}
          </button>
        </DropdownMenuTrigger>
      </SidebarRailTooltip>
      <DropdownMenuContent
        side="right"
        align={align}
        sideOffset={8}
        className="min-w-52"
        {...contentProps}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
