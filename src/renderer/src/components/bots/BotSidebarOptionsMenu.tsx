import React from 'react'
import { Moon, Pause } from 'lucide-react'
import { DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { FilterToggleRow } from '@/components/sidebar/worktree-list/controls/FilterToggleRow'
import { OptionChoiceSubmenu } from '@/components/sidebar/worktree-list/controls/OptionChoiceSubmenu'
import { SidebarOptionsPopover } from '@/components/sidebar/worktree-list/controls/SidebarOptionsPopover'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import {
  BOT_SIDEBAR_SORT_CHOICES,
  countActiveBotSidebarFilters,
  type BotSidebarSortBy
} from '../../../../shared/bots/bot-sidebar-view'

const SORT_LABELS: Record<BotSidebarSortBy, () => string> = {
  manual: () => translate('bots.options.sortManual', 'Manual'),
  smart: () => translate('bots.options.sortSmart', 'Agent Activity'),
  recent: () => translate('bots.options.sortRecent', 'Recent'),
  name: () => translate('bots.options.sortName', 'Name')
}
const SORT_DESCRIPTIONS: Partial<Record<BotSidebarSortBy, () => string>> = {
  manual: () =>
    translate(
      'bots.options.sortManualDescription',
      'Drag bots to arrange them. New bots go on top.'
    ),
  smart: () =>
    translate('bots.options.sortSmartDescription', 'Bots that need you, then most recent activity.')
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
    label: SORT_LABELS[id](),
    description: SORT_DESCRIPTIONS[id]?.() ?? null
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
      <DropdownMenuLabel variant="title">{title}</DropdownMenuLabel>
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
    </SidebarOptionsPopover>
  )
}
