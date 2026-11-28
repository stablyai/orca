import React from 'react'
import type {
  ActivityBarPosition,
  ActiveRightSidebarTab
} from '../../../../../shared/ui-chrome/ui-chrome-types'
import type { CheckStatus as CoarseCheckStatus } from '../../../../../shared/github/pull-requests/pull-request-types'
import { cn } from '@/lib/class-names'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { ActivityBarPositionMenu } from './activity-bar-position-menu'
import {
  ACTIVITY_BAR_STATUS_DOT_COLOR,
  openKeyboardContextMenu,
  type ActivityBarItem
} from './activity-bar-buttons'
import { activityItemAriaLabel, activityItemStatus } from './activity-bar-item-names'

type CheckStatus = CoarseCheckStatus | 'cancelled'

export type TopActivityOverflowMenuContentProps = {
  items: ActivityBarItem[]
  activeTab: ActiveRightSidebarTab
  onSelect: (tab: ActiveRightSidebarTab, fromKeyboard: boolean) => void
  checksStatus?: CheckStatus | null
  arrangementItems: ActivityBarItem[]
  activityBarPosition: ActivityBarPosition
  onChangeActivityBarPosition: (position: ActivityBarPosition) => void
  isBotPage?: boolean
  stripItemIds?: ReadonlySet<string>
  triggerRef: React.RefObject<HTMLButtonElement | null>
  focusBeforeOpenRef: React.RefObject<Element | null>
}

export function TopActivityOverflowMenuContent({
  items,
  activeTab,
  onSelect,
  checksStatus,
  arrangementItems,
  activityBarPosition,
  onChangeActivityBarPosition,
  isBotPage,
  stripItemIds,
  triggerRef,
  focusBeforeOpenRef
}: TopActivityOverflowMenuContentProps): React.JSX.Element {
  const t = useTranslate()

  return (
    <DropdownMenuContent
      data-activity-bar-menu=""
      align="end"
      side="bottom"
      sideOffset={6}
      onCloseAutoFocus={(event) => {
        const before = focusBeforeOpenRef.current
        focusBeforeOpenRef.current = null
        // Keep focus that moved on (e.g. into Agents search); else return it to where the menu opened from.
        event.preventDefault()
        const active = document.activeElement
        if (
          (!active || active === document.body) &&
          before instanceof HTMLElement &&
          before.isConnected
        ) {
          before.focus({ preventScroll: true })
        }
      }}
    >
      {items.map((item) => {
        const Icon = item.icon
        const active = item.id === activeTab
        const status = activityItemStatus(item, checksStatus)
        return (
          <ContextMenu key={item.id}>
            <ContextMenuTrigger asChild>
              <DropdownMenuItem
                // Focus on More when it opened means the keyboard opened it.
                onSelect={() =>
                  onSelect(item.id, focusBeforeOpenRef.current === triggerRef.current)
                }
                onKeyDown={openKeyboardContextMenu}
                data-activity-item-id={item.id}
                data-workspace-board-dismiss=""
                data-activity-plugin-key={item.pluginKey}
                className={cn(active && 'bg-accent text-accent-foreground')}
                aria-current={active ? 'page' : undefined}
                aria-label={activityItemAriaLabel(item, status, t)}
              >
                <Icon size={14} />
                <span>{item.title}</span>
                {status && status !== 'neutral' ? (
                  <span
                    className={cn(
                      'ml-auto size-2 rounded-full',
                      ACTIVITY_BAR_STATUS_DOT_COLOR[status]
                    )}
                    aria-hidden="true"
                  />
                ) : null}
                {item.shortcut && <DropdownMenuShortcut>{item.shortcut}</DropdownMenuShortcut>}
              </DropdownMenuItem>
            </ContextMenuTrigger>
            <ActivityBarPositionMenu
              currentPosition={activityBarPosition}
              onChangePosition={onChangeActivityBarPosition}
              pluginKey={item.pluginKey}
              itemId={item.id}
              items={arrangementItems}
              isBotPage={isBotPage}
              stripItemIds={stripItemIds}
            />
          </ContextMenu>
        )
      })}
    </DropdownMenuContent>
  )
}
