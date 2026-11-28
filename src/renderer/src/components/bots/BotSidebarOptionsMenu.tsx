import React from 'react'
import { Moon, Pause } from 'lucide-react'
import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { HostListOverflowNote } from '@/components/host-picker/HostListOverflowNote'
import { HostListSearchField } from '@/components/host-picker/HostListSearchField'
import { useBoundedHostRows } from '@/components/host-picker/use-bounded-host-rows'
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
import {
  ALL_EXECUTION_HOSTS_SCOPE,
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostScope
} from '../../../../shared/execution-host/execution-host'
import type { BotSidebarHostFilter } from './use-bot-sidebar-host-filter'

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
export function BotSidebarOptionsMenu({
  hostFilter
}: {
  hostFilter: BotSidebarHostFilter | null
}): React.JSX.Element {
  const t = useTranslate()
  const view = useAppStore((s) => s.botSidebarView)
  const setView = useAppStore((s) => s.setBotSidebarView)
  const activeFilterCount =
    countActiveBotSidebarFilters(view) +
    (hostFilter && hostFilter.scope !== ALL_EXECUTION_HOSTS_SCOPE ? 1 : 0)
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
      {hostFilter ? <BotSidebarHostMenu {...hostFilter} /> : null}
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

function BotSidebarHostMenu({
  scope,
  pairedHosts,
  onChange
}: BotSidebarHostFilter): React.JSX.Element {
  const t = useTranslate()
  const allLabel = t('auto.components.automations.hostPicker.allHosts', 'All hosts')
  const localLabel = t('runtime.health.local', 'Local')
  const selectedLabel =
    scope === ALL_EXECUTION_HOSTS_SCOPE
      ? allLabel
      : scope === LOCAL_EXECUTION_HOST_ID
        ? localLabel
        : (pairedHosts.find((host) => host.id === scope)?.label ?? scope)
  const rows = useBoundedHostRows(pairedHosts, new Set([scope]))
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
          <span>{t('auto.components.automations.AutomationsPage.tableHost', 'Host')}</span>
          <span className="truncate text-2xs font-medium text-muted-foreground">
            {selectedLabel}
          </span>
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-44">
        <div className="max-h-80 overflow-y-auto scrollbar-sleek">
          <DropdownMenuRadioGroup
            value={scope}
            onValueChange={(value) => onChange(normalizeExecutionHostScope(value))}
          >
            <DropdownMenuRadioItem
              value={ALL_EXECUTION_HOSTS_SCOPE}
              onSelect={(event) => event.preventDefault()}
            >
              {allLabel}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem
              value={LOCAL_EXECUTION_HOST_ID}
              onSelect={(event) => event.preventDefault()}
            >
              {localLabel}
            </DropdownMenuRadioItem>
            {rows.searchable ? (
              <HostListSearchField value={rows.query} onChange={rows.setQuery} inMenu />
            ) : null}
            {rows.shown.map(({ id, label }) => (
              <DropdownMenuRadioItem
                key={id}
                value={id}
                onSelect={(event) => event.preventDefault()}
              >
                <span className="truncate">{label}</span>
              </DropdownMenuRadioItem>
            ))}
            <HostListOverflowNote hiddenCount={rows.hiddenCount} />
          </DropdownMenuRadioGroup>
        </div>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
