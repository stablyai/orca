import React, { useRef } from 'react'
import { MoreHorizontal } from 'lucide-react'
import type { ActiveRightSidebarTab } from '../../../../../shared/ui-chrome/ui-chrome-types'
import type { CheckStatus as CoarseCheckStatus } from '../../../../../shared/github/pull-requests/pull-request-types'
type CheckStatus = CoarseCheckStatus | 'cancelled'
import { cn } from '@/lib/class-names'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME } from '../layout/right-sidebar-titlebar-drag-regions'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { keepFocusPressProps } from '@/lib/overlay-interaction/focus-keeping-press'

export type ActivityBarItem = {
  id: ActiveRightSidebarTab
  pluginKey?: string
  icon: React.ComponentType<{ size?: number; className?: string }>
  title: string
  shortcut: string
  /** When true, hidden for non-git (folder-mode) repos. */
  gitOnly?: boolean
  /** When true, shown only for folder workspaces. */
  folderOnly?: boolean
  /** When true, shown only for workspaces on an SSH host. */
  sshOnly?: boolean
  /** When true, shown on a bot's page, and for a chat whose workers it lists. */
  botOnly?: boolean
  /** When true, shown only on a bot's page. */
  botPageOnly?: boolean
  /** When true, also shown on a bot's page, which hides every other panel. */
  onBotPage?: boolean
  /** Host-owned health indicator; plugin content cannot style this chrome. */
  statusIndicator?: CheckStatus
  /** Something new inside, such as a bot's new Up next suggestions; shown while the tab isn't open. */
  count?: number
  /** What the count means, for its label; "{{count}} new" when absent. */
  countLabel?: string
  /** In the top bar, a pill with its icon, title and count (shown even while open), as on a bot's page. */
  labeledTab?: boolean
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
  const titled = item.shortcut ? `${item.title} (${item.shortcut})` : item.title
  const base = item.count
    ? `${titled}, ${item.countLabel ?? t('bots.upNext.newCount', '{{count}} new', { count: item.count })}`
    : titled
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
  onSelect: (tab: ActiveRightSidebarTab, fromKeyboard: boolean) => void
  checksStatus?: CheckStatus | null
}): React.JSX.Element {
  const t = useTranslate()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const focusBeforeOpenRef = useRef<Element | null>(null)
  const interactedOutsideRef = useRef(false)
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
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) {
          focusBeforeOpenRef.current = document.activeElement
          interactedOutsideRef.current = false
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          {...keepFocusPressProps}
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
      <DropdownMenuContent
        align="end"
        side="bottom"
        sideOffset={6}
        onInteractOutside={() => {
          interactedOutsideRef.current = true
        }}
        onCloseAutoFocus={(event) => {
          const before = focusBeforeOpenRef.current
          focusBeforeOpenRef.current = null
          // A mouse-opened menu hands focus back to where it was (the terminal), not to More.
          if (
            !interactedOutsideRef.current &&
            before instanceof HTMLElement &&
            before !== document.body &&
            before !== triggerRef.current &&
            before.isConnected
          ) {
            event.preventDefault()
            before.focus({ preventScroll: true })
          }
        }}
      >
        {items.map((item) => {
          const Icon = item.icon
          const active = item.id === activeTab
          return (
            <DropdownMenuItem
              key={item.id}
              // Focus on More when it opened means the keyboard opened it.
              onSelect={() => onSelect(item.id, focusBeforeOpenRef.current === triggerRef.current)}
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

function ActivityCount({ count }: { count: number }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-foreground px-1 text-3xs font-semibold leading-none text-background tabular-nums"
    >
      {count}
    </span>
  )
}

export function ActivityBarButton({
  item,
  active,
  onClick,
  layout,
  statusIndicator,
  compact = false
}: {
  item: ActivityBarItem
  active: boolean
  onClick: (fromKeyboard: boolean) => void
  layout: 'top' | 'side'
  statusIndicator?: CheckStatus | null
  /** A labeled tab that isn't open shows its icon alone, for a bar too narrow for every title. */
  compact?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const Icon = item.icon
  const isTop = layout === 'top'
  const effectiveStatus = item.statusIndicator ?? statusIndicator
  const isPill = isTop && item.labeledTab === true
  const showLabel = isPill && (active || !compact)

  const button = (
    <button
      type="button"
      className={cn(
        'relative flex items-center justify-center transition-colors',
        RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME,
        isPill
          ? cn(
              'h-7 rounded-md text-xs font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              showLabel ? 'min-w-0 shrink gap-1.5 px-2' : 'w-7 shrink-0',
              active
                ? 'bg-foreground/10 text-foreground'
                : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
            )
          : cn(
              'shrink-0',
              isTop ? 'h-[36px] w-9' : 'w-10 h-10',
              active ? 'text-foreground' : 'text-muted-foreground/60 hover:text-muted-foreground'
            )
      )}
      // Enter and Space fire click with detail 0.
      onClick={(event) => onClick(event.detail === 0)}
      {...keepFocusPressProps}
      data-workspace-board-dismiss=""
      data-activity-plugin-key={item.pluginKey}
      aria-label={activityItemAriaLabel(item, effectiveStatus, t)}
      aria-current={active ? 'page' : undefined}
    >
      {showLabel ? (
        <>
          <Icon size={14} className="shrink-0" />
          <span className="min-w-0 truncate">{item.title}</span>
          {item.count ? <ActivityCount count={item.count} /> : null}
        </>
      ) : (
        <Icon size={isPill ? 14 : isTop ? 16 : 18} />
      )}

      {effectiveStatus && effectiveStatus !== 'neutral' && (
        <div
          className={cn(
            'absolute rounded-full size-[7px] ring-1 ring-sidebar',
            isPill
              ? 'top-0.5 right-0.5'
              : isTop
                ? 'top-[8px] right-[5px]'
                : 'top-[7px] right-[7px]',
            STATUS_DOT_COLOR[effectiveStatus] ?? 'bg-muted-foreground'
          )}
        />
      )}

      {item.count && !active && !showLabel ? (
        <span
          aria-hidden="true"
          className={cn(
            'absolute flex h-3.5 min-w-3.5 items-center justify-center rounded-full border border-border bg-background px-0.5 text-3xs leading-none text-foreground tabular-nums',
            // Inside the pill's height and 2px gap, so the badge never depends on the strip's clip.
            isPill ? '-right-0.5 top-0' : 'right-0.5 top-1.5'
          )}
        >
          {item.count}
        </span>
      ) : null}

      {active && isTop && !isPill && (
        <div className="absolute bottom-0 left-[25%] right-[25%] h-[2px] bg-activity-bar-indicator rounded-t" />
      )}
      {active && !isTop && (
        <div className="absolute right-0 top-[25%] bottom-[25%] w-[2px] bg-activity-bar-indicator rounded-l" />
      )}
    </button>
  )

  // A visible title names the tab; only icon-only tabs need a tooltip.
  if (showLabel) {
    return button
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side={isTop ? 'bottom' : 'left'} sideOffset={6}>
        {item.shortcut ? `${item.title} (${item.shortcut})` : item.title}
      </TooltipContent>
    </Tooltip>
  )
}
