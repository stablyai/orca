import React from 'react'
import { cn } from '@/lib/class-names'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export const APP_RAIL_ITEM_ATTRIBUTE = 'data-app-rail-item'

export const APP_RAIL_ICON_SIZE = 16
export const APP_RAIL_ICON_STROKE_WIDTH = 1.75

const APP_RAIL_ITEM_IDS = [
  'workspaces',
  'tasks',
  'automations',
  'artifacts',
  'skills',
  'mobile',
  'customize',
  'more',
  'help',
  'settings'
] as const
export type AppRailItemId = (typeof APP_RAIL_ITEM_IDS)[number]

export function isAppRailItemId(value: unknown): value is AppRailItemId {
  return APP_RAIL_ITEM_IDS.some((id) => id === value)
}

type AppRailButtonProps = Omit<React.ComponentProps<'button'>, 'id'> & {
  itemId: AppRailItemId
  icon: React.ReactNode
  label: string
  active?: boolean
  tabStop: boolean
}

export function AppRailButton({
  itemId,
  icon,
  label,
  active = false,
  tabStop,
  className,
  ...props
}: AppRailButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      {...props}
      {...{ [APP_RAIL_ITEM_ATTRIBUTE]: itemId }}
      tabIndex={tabStop ? 0 : -1}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-muted-foreground focus-visible:ring-offset-1 focus-visible:ring-offset-worktree-sidebar [&>svg]:transition-opacity',
        // Why svg opacity, not an alpha color: per-stroke alpha brightens where strokes overlap.
        active
          ? 'bg-worktree-sidebar-foreground/10 text-foreground'
          : 'text-muted-foreground hover:bg-worktree-sidebar-foreground/6 data-[state=open]:bg-worktree-sidebar-foreground/10 data-[state=open]:text-foreground [&>svg]:opacity-70 hover:[&>svg]:opacity-100 data-[state=open]:[&>svg]:opacity-100 forced-colors:[&>svg]:opacity-100',
        className
      )}
    >
      {icon}
    </button>
  )
}

/** Tooltip to the right of a rail button; it also shows on keyboard focus. */
export function RailItem({
  tooltip,
  children
}: {
  tooltip: React.ReactNode
  children: React.ReactElement
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={6}>
        <span className="flex items-center gap-1.5">{tooltip}</span>
      </TooltipContent>
    </Tooltip>
  )
}
