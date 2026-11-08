import React from 'react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { useShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'
import type { KeybindingActionId } from '../../../../shared/keybindings'

export const SIDEBAR_RAIL_STACK_CLASS = 'flex flex-col items-center gap-0.5'

export function sidebarRailButtonClassName(active = false): string {
  return cn(
    'relative flex size-8 shrink-0 items-center justify-center rounded-md p-0 transition-colors',
    active
      ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground hover:bg-worktree-sidebar-accent dark:hover:bg-worktree-sidebar-accent'
      : 'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8 hover:text-worktree-sidebar-foreground dark:hover:bg-worktree-sidebar-foreground/8'
  )
}

function SidebarRailShortcut({
  actionId
}: {
  actionId: KeybindingActionId
}): React.JSX.Element | null {
  const [combo] = useShortcutKeyComboDetails(actionId)
  if (!combo || combo.keys.length === 0) {
    return null
  }
  return (
    <ShortcutKeyCombo
      keys={combo.keys}
      doubleTap={combo.doubleTap}
      className="gap-0.5"
      keyCapClassName="min-w-0 border-background/20 bg-background/10 px-1 py-0 text-3xs text-background shadow-none"
      separatorClassName="text-3xs text-background/70"
    />
  )
}

export function SidebarRailTooltip({
  label,
  shortcutActionId,
  open,
  children
}: {
  label: React.ReactNode
  shortcutActionId?: KeybindingActionId
  open?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip open={open}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        <span className="flex items-center gap-1.5">
          {label}
          {shortcutActionId ? <SidebarRailShortcut actionId={shortcutActionId} /> : null}
        </span>
      </TooltipContent>
    </Tooltip>
  )
}

export function SidebarRailBadge({
  label,
  className,
  children
}: {
  label?: string
  className?: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <span
      aria-label={label}
      className={cn(
        'pointer-events-none absolute right-0.5 top-0.5 flex items-center justify-center',
        className
      )}
    >
      {children}
    </span>
  )
}
