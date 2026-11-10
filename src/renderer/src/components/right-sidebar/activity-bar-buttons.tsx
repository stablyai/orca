import React from 'react'
import { MoreHorizontal } from 'lucide-react'
import type { ActiveRightSidebarTab } from '../../../../shared/ui-chrome-types'
import type { CheckStatus as CoarseCheckStatus } from '../../../../shared/github/pull-request-types'
type CheckStatus = CoarseCheckStatus | 'cancelled'
import { cn } from '@/lib/class-names'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME } from './right-sidebar-titlebar-drag-regions'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'

export type ActivityBarItem = {
  id: ActiveRightSidebarTab
  pluginKey?: string
  icon: React.ComponentType<{ size?: number; className?: string }>
  title: string
  shortcut: string
  /** When true, hidden for non-git (folder-mode) repos. */
  gitOnly?: boolean
  /** When true, stays visible for folder repos that are Perforce workspaces. */
  perforceCapable?: boolean
  /** When true, shown only for folder workspaces. */
  folderOnly?: boolean
  /** When true, shown only for workspaces on an SSH host. */
  sshOnly?: boolean
  /** Host-owned health indicator; plugin content cannot style this chrome. */
  statusIndicator?: CheckStatus
}

const STATUS_DOT_COLOR: Record<CheckStatus, string> = {
  success: 'bg-emerald-500',
  failure: 'bg-rose-500',
  pending: 'bg-amber-500',
  neutral: 'bg-muted-foreground',
  cancelled: 'bg-muted-foreground'
}

function activityItemAriaLabel(
  item: ActivityBarItem,
  status?: CheckStatus | null,
  t: Translate = translate
): string {
  const base = item.shortcut ? `${item.title} (${item.shortcut})` : item.title
  return status === 'failure'
    ? `${base} — ${t('auto.components.right.sidebar.activityBar.error', 'Error')}`
    : status === 'cancelled'
      ? `${base} — ${t('auto.components.editor.CheckRunDetailsPanel.91a4c7e2b0', 'Cancelled')}`
      : base
}

export function TopActivityOverflowMenu({
  items,
  activeTab,
  onSelect,
  checksStatus
}: {
  items: ActivityBarItem[]
  activeTab: ActiveRightSidebarTab
  onSelect: (tab: ActiveRightSidebarTab) => void
  checksStatus?: CheckStatus | null
}): React.JSX.Element {
  const t = useTranslate()
  const hiddenChecksStatus =
    checksStatus && checksStatus !== 'neutral' && items.some((item) => item.id === 'checks')
      ? checksStatus
      : null
  const hiddenItemStatus = items.some((item) => item.statusIndicator === 'failure')
    ? 'failure'
    : hiddenChecksStatus
  const moreTabsLabel = t(
    'auto.components.right.sidebar.activity.bar.buttons.1fd284e931',
    'More sidebar tabs'
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'relative flex h-[36px] w-8 shrink-0 items-center justify-center text-muted-foreground/60 transition-colors hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME
          )}
          aria-label={
            hiddenItemStatus === 'failure'
              ? `${moreTabsLabel} — ${t('auto.components.right.sidebar.activityBar.error', 'Error')}`
              : hiddenItemStatus === 'cancelled'
                ? `${moreTabsLabel} — ${t('auto.components.editor.CheckRunDetailsPanel.91a4c7e2b0', 'Cancelled')}`
                : moreTabsLabel
          }
        >
          <MoreHorizontal size={16} />
          {hiddenItemStatus && (
            <div
              className={cn(
                'absolute top-[8px] right-[4px] size-[7px] rounded-full ring-1 ring-sidebar',
                STATUS_DOT_COLOR[hiddenItemStatus] ?? 'bg-muted-foreground'
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
              data-workspace-board-dismiss=""
              data-activity-plugin-key={item.pluginKey}
              className={cn(active && 'bg-accent text-accent-foreground')}
              aria-current={active ? 'page' : undefined}
              aria-label={activityItemAriaLabel(item, item.statusIndicator, t)}
            >
              <Icon size={14} />
              <span>{item.title}</span>
              {item.statusIndicator === 'failure' ? (
                <span
                  className={cn('ml-auto size-2 rounded-full', STATUS_DOT_COLOR.failure)}
                  aria-hidden="true"
                />
              ) : null}
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
  const t = useTranslate()
  const Icon = item.icon
  const isTop = layout === 'top'
  const effectiveStatus = item.statusIndicator ?? statusIndicator

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            'relative flex shrink-0 items-center justify-center transition-colors',
            RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME,
            isTop ? 'h-[36px] w-9' : 'w-10 h-10',
            active ? 'text-foreground' : 'text-muted-foreground/60 hover:text-muted-foreground'
          )}
          onClick={onClick}
          data-workspace-board-dismiss=""
          data-activity-plugin-key={item.pluginKey}
          aria-label={activityItemAriaLabel(item, effectiveStatus, t)}
        >
          <Icon size={isTop ? 16 : 18} />

          {effectiveStatus && effectiveStatus !== 'neutral' && (
            <div
              className={cn(
                'absolute rounded-full size-[7px] ring-1 ring-sidebar',
                isTop ? 'top-[8px] right-[5px]' : 'top-[7px] right-[7px]',
                STATUS_DOT_COLOR[effectiveStatus] ?? 'bg-muted-foreground'
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
