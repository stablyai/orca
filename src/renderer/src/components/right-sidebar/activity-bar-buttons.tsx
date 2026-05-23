import React from 'react'
import { MoreHorizontal } from 'lucide-react'
import type { RightSidebarTab } from '@/store/slices/editor'
import type { CheckStatus } from '../../../../shared/types'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

export type ActivityBarItem = {
  id: RightSidebarTab
  icon: React.ComponentType<{ size?: number; className?: string }>
  title: string
  shortcut: string
  /** When true, hidden for non-git (folder-mode) repos. */
  gitOnly?: boolean
  /** When true, shown only for worktrees that belong to an SSH repo. */
  sshOnly?: boolean
}

const STATUS_DOT_COLOR: Record<CheckStatus, string> = {
  success: 'bg-emerald-500',
  failure: 'bg-rose-500',
  pending: 'bg-amber-500',
  neutral: 'bg-muted-foreground'
}

export function TopActivityOverflowMenu({
  items,
  activeTab,
  onSelect,
  checksStatus
}: {
  items: ActivityBarItem[]
  activeTab: RightSidebarTab
  onSelect: (tab: RightSidebarTab) => void
  checksStatus?: CheckStatus | null
}): React.JSX.Element {
  const hiddenChecksStatus =
    checksStatus && checksStatus !== 'neutral' && items.some((item) => item.id === 'checks')
      ? checksStatus
      : null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="relative flex h-[36px] w-8 shrink-0 items-center justify-center text-muted-foreground/60 transition-colors hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label="More sidebar tabs"
        >
          <MoreHorizontal size={16} />
          {hiddenChecksStatus && (
            <div
              className={cn(
                'absolute top-[8px] right-[4px] size-[7px] rounded-full ring-1 ring-sidebar',
                STATUS_DOT_COLOR[hiddenChecksStatus] ?? 'bg-muted-foreground'
              )}
            />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="bottom" sideOffset={6}>
        {items.map((item) => {
          const Icon = item.icon
          const active = item.id === activeTab
          return (
            <DropdownMenuItem
              key={item.id}
              onSelect={() => onSelect(item.id)}
              className={cn(active && 'bg-accent text-accent-foreground')}
              aria-current={active ? 'page' : undefined}
            >
              <Icon size={14} />
              <span>{item.title}</span>
              {item.shortcut && <DropdownMenuShortcut>{item.shortcut}</DropdownMenuShortcut>}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ActivityBarButton({
  item,
  active,
  onClick,
  layout,
  statusIndicator
}: {
  item: ActivityBarItem
  active: boolean
  onClick: () => void
  layout: 'top' | 'side'
  statusIndicator?: CheckStatus | null
}): React.JSX.Element {
  const Icon = item.icon
  const isTop = layout === 'top'

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            'relative flex shrink-0 items-center justify-center transition-colors right-sidebar-header-no-drag',
            isTop ? 'h-[36px] w-9' : 'w-10 h-10',
            active ? 'text-foreground' : 'text-muted-foreground/60 hover:text-muted-foreground'
          )}
          onClick={onClick}
          aria-label={item.shortcut ? `${item.title} (${item.shortcut})` : item.title}
        >
          <Icon size={isTop ? 16 : 18} />

          {statusIndicator && statusIndicator !== 'neutral' && (
            <div
              className={cn(
                'absolute rounded-full size-[7px] ring-1 ring-sidebar',
                isTop ? 'top-[8px] right-[5px]' : 'top-[7px] right-[7px]',
                STATUS_DOT_COLOR[statusIndicator] ?? 'bg-muted-foreground'
              )}
            />
          )}

          {active && isTop && (
            <div className="absolute bottom-0 left-[25%] right-[25%] h-[2px] bg-foreground rounded-t" />
          )}
          {active && !isTop && (
            <div className="absolute right-0 top-[25%] bottom-[25%] w-[2px] bg-foreground rounded-l" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side={isTop ? 'bottom' : 'left'} sideOffset={6}>
        {item.shortcut ? `${item.title} (${item.shortcut})` : item.title}
      </TooltipContent>
    </Tooltip>
  )
}
