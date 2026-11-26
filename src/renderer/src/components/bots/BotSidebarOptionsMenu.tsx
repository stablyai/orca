import React from 'react'
import { Moon, Pause, Users } from 'lucide-react'
import { DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { FilterToggleRow } from '@/components/sidebar/worktree-list/controls/FilterToggleRow'
import { OptionChoiceSubmenu } from '@/components/sidebar/worktree-list/controls/OptionChoiceSubmenu'
import { SidebarOptionsPopover } from '@/components/sidebar/worktree-list/controls/SidebarOptionsPopover'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import {
  BOT_SIDEBAR_SORT_CHOICES,
  countActiveBotSidebarFilters,
  type BotSidebarSortBy
} from '../../../../shared/bots/bot-sidebar-view'

// Take the render's t: React Compiler caches the choices on their inputs, so module translate()
// here kept the sort menu in the previous language after a switch.
const SORT_LABELS: Record<BotSidebarSortBy, (t: Translate) => string> = {
  manual: (t) => t('bots.options.sortManual', 'Manual'),
  smart: (t) => t('bots.options.sortSmart', 'Agent Activity'),
  recent: (t) => t('bots.options.sortRecent', 'Recent'),
  name: (t) => t('bots.options.sortName', 'Name')
}
const SORT_DESCRIPTIONS: Partial<Record<BotSidebarSortBy, (t: Translate) => string>> = {
  manual: (t) =>
    t('bots.options.sortManualDescription', 'Drag bots to arrange them. New bots go on top.'),
  smart: (t) =>
    t('bots.options.sortSmartDescription', 'Bots that need you, then most recent activity.')
}

/** The Bots header's options: how the section orders its bots and what it leaves out. */
export function BotSidebarOptionsMenu(): React.JSX.Element {
  const t = useTranslate()
  const view = useAppStore((s) => s.botSidebarView)
  const setView = useAppStore((s) => s.setBotSidebarView)
  const activeFilterCount = countActiveBotSidebarFilters(view)
  const title = t('bots.options.title', 'Bot options')
  const choices = BOT_SIDEBAR_SORT_CHOICES.map(({ id }) => ({
    id,
    label: SORT_LABELS[id](t),
    description: SORT_DESCRIPTIONS[id]?.(t) ?? null
  }))
  return (
    <SidebarOptionsPopover
      ariaLabel={
        activeFilterCount > 0
          ? t('bots.options.activeFilters', 'Bot options ({{count}} filters active)', {
              count: activeFilterCount,
              defaultValue_one: 'Bot options ({{count}} filter active)'
            })
          : title
      }
      tooltip={title}
      activeFilterCount={activeFilterCount}
    >
      <DropdownMenuLabel>{title}</DropdownMenuLabel>
      <OptionChoiceSubmenu
        label={t('bots.options.sortBy', 'Sort by')}
        choices={choices}
        value={view.sortBy}
        onChange={(sortBy) => setView({ sortBy })}
      />
      <DropdownMenuSeparator />
      <div className="flex items-center justify-between px-2 py-1">
        <span className="text-[11px] font-semibold text-muted-foreground">
          {t('bots.options.filters', 'Filters')}
        </span>
      </div>
      <FilterToggleRow
        icon={<Pause className="size-3.5" />}
        label={t('bots.options.hidePaused', 'Hide paused bots')}
        checked={view.hidePausedBots}
        onChange={(hidePausedBots) => setView({ hidePausedBots })}
      />
      <FilterToggleRow
        icon={<Moon className="size-3.5" />}
        label={t('bots.options.hideSleepingWorkers', 'Hide sleeping workers')}
        ariaLabel={t(
          'bots.options.hideSleepingWorkersAria',
          "Hide a bot's worker workspaces that have nothing running"
        )}
        checked={view.hideSleepingWorkers}
        onChange={(hideSleepingWorkers) => setView({ hideSleepingWorkers })}
      />
      <FilterToggleRow
        icon={<Users className="size-3.5" />}
        label={t('bots.options.groupsOnly', 'Groups only')}
        ariaLabel={t(
          'bots.options.groupsOnlyAria',
          'Show only bot groups and hide standalone bots'
        )}
        checked={view.showGroupsOnly}
        onChange={(showGroupsOnly) => setView({ showGroupsOnly })}
      />
    </SidebarOptionsPopover>
  )
}
