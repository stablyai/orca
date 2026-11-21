import React, { useCallback, useMemo, useState } from 'react'
import {
  CalendarClock,
  Check,
  FolderPlus,
  GitBranch,
  GitCommitHorizontal,
  ListFilter,
  Moon,
  Server,
  SquareTerminal
} from 'lucide-react'
import { useAppStore } from '@/store/index'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import RepoBadgeLabel from '@/components/repo/RepoBadgeLabel'
import { FilterToggleRow } from './FilterToggleRow'
import {
  isProjectFilterEntrySelected,
  withoutProjectFilterEntry,
  withProjectFilterEntry
} from '../../../../../../shared/sidebar-list/sections/project-filter-entries'
import {
  searchProjectFilterEntries,
  useProjectFilterEntries,
  type RepoProjectFilterEntry
} from './use-project-filter-entries'
import { useShortcutLabel } from '@/lib/keyboard/useShortcutLabel'
import { isUnassignedShortcutLabel } from '@/i18n/unassigned-label'
import { clearSidebarFilters, selectSidebarFilterState } from './sidebar-filter-actions'
import { useWorkspaceOptionsFilterBadge } from './workspace-options-menu-items'
import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { withoutHiddenRepos } from '../../../../../../shared/project/catalog/hidden-projects'

type SidebarFilterProps = {
  preserveWorkspaceBoardOpen?: boolean
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left'
  contentSide?: 'top' | 'right' | 'bottom' | 'left'
  onMenuOpenChange?: (open: boolean) => void
}

const SidebarFilter = React.memo(function SidebarFilter({
  preserveWorkspaceBoardOpen = false,
  tooltipSide = 'bottom',
  contentSide = 'right',
  onMenuOpenChange
}: SidebarFilterProps) {
  const t = useTranslate()
  useUiLanguageRevision()
  const showSleepingWorkspaces = useAppStore((s) => s.showSleepingWorkspaces)
  const setShowSleepingWorkspaces = useAppStore((s) => s.setShowSleepingWorkspaces)
  // Expose user bindings here so the filter menu also teaches the sleeping-workspace shortcut.
  const sleepingShortcut = useShortcutLabel('sidebar.sleepingWorkspaces.toggle')
  const hideDefaultBranchWorkspace = useAppStore((s) => s.hideDefaultBranchWorkspace)
  const setHideDefaultBranchWorkspace = useAppStore((s) => s.setHideDefaultBranchWorkspace)
  const hideAutomationGeneratedWorkspaces = useAppStore((s) => s.hideAutomationGeneratedWorkspaces)
  const setHideAutomationGeneratedWorkspaces = useAppStore(
    (s) => s.setHideAutomationGeneratedWorkspaces
  )
  const hideCliCreatedWorkspaces = useAppStore((s) => s.hideCliCreatedWorkspaces)
  const setHideCliCreatedWorkspaces = useAppStore((s) => s.setHideCliCreatedWorkspaces)
  const hideDetachedHeadWorkspaces = useAppStore((s) => s.hideDetachedHeadWorkspaces)
  const setHideDetachedHeadWorkspaces = useAppStore((s) => s.setHideDetachedHeadWorkspaces)
  const alwaysShowDefaultBranchWorkspace = useAppStore((s) => s.alwaysShowDefaultBranchWorkspace)
  const setAlwaysShowDefaultBranchWorkspace = useAppStore(
    (s) => s.setAlwaysShowDefaultBranchWorkspace
  )
  const filterRepoIds = useAppStore((s) => s.filterRepoIds)
  const setFilterRepoIds = useAppStore((s) => s.setFilterRepoIds)
  const allRepos = useAppStore((s) => s.repos)
  const repos = useMemo(() => withoutHiddenRepos(allRepos), [allRepos])
  const entries = useProjectFilterEntries(repos)
  const addRepo = useAppStore((s) => s.addRepo)

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [commandValueOverride, setCommandValueOverride] = useState<string | null>(null)

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next)
      onMenuOpenChange?.(next)
      if (!next) {
        setQuery('')
      }
    },
    [onMenuOpenChange]
  )

  const handleToggleEntry = useCallback(
    (entry: RepoProjectFilterEntry) => {
      setFilterRepoIds(
        isProjectFilterEntrySelected(entry, filterRepoIds)
          ? withoutProjectFilterEntry(filterRepoIds, entry, entries)
          : withProjectFilterEntry(filterRepoIds, entry, entries)
      )
    },
    [entries, filterRepoIds, setFilterRepoIds]
  )

  // Entries come from current repos, so removed repo IDs cannot inflate counts or imply a filter.
  const selectedEntryKeySet = useMemo(
    () =>
      new Set(
        entries
          .filter((entry) => isProjectFilterEntrySelected(entry, filterRepoIds))
          .map((entry) => entry.key)
      ),
    [entries, filterRepoIds]
  )
  const selectedCount = selectedEntryKeySet.size
  // Keep the section while a filter is active, even when grouping leaves a single project.
  const canFilterRepos = entries.length > 1 || selectedCount > 0
  const hasRepoFilter = selectedCount > 0
  const { hasAnyFilter, activeFilterCount } = useWorkspaceOptionsFilterBadge()

  const filteredEntries = useMemo(
    () => searchProjectFilterEntries(entries, query),
    [entries, query]
  )
  const commandValue =
    commandValueOverride && filteredEntries.some((entry) => entry.key === commandValueOverride)
      ? commandValueOverride
      : (filteredEntries[0]?.key ?? '')
  // Every checkout, not every project: a project saved for one host still hides the others.
  const allSelected = canFilterRepos && repos.every((repo) => filterRepoIds.includes(repo.id))

  const clearAll = useCallback(() => {
    const store = useAppStore.getState()
    clearSidebarFilters(selectSidebarFilterState(store), store)
  }, [])

  // Use current repos so Select All includes projects added while the popover stays open.
  const selectAllRepos = useCallback(() => {
    setFilterRepoIds(repos.map((r) => r.id))
  }, [repos, setFilterRepoIds])

  const clearRepos = useCallback(() => setFilterRepoIds([]), [setFilterRepoIds])

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              aria-label={
                hasAnyFilter
                  ? t(
                      'auto.components.sidebar.SidebarFilter.75405270ed',
                      'Edit filters ({{value0}} active)',
                      { value0: activeFilterCount }
                    )
                  : t('auto.components.sidebar.SidebarFilter.f506a1262a', 'Filter workspaces')
              }
              className="relative text-muted-foreground"
              data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
            >
              <ListFilter className="size-3.5" strokeWidth={2.25} />
              {hasAnyFilter && (
                // Expose active filters so silently hidden workspaces have an at-a-glance explanation.
                <span
                  aria-hidden
                  className="absolute -top-0.5 -right-0.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-medium leading-none text-primary-foreground"
                >
                  {activeFilterCount > 9 ? '9+' : activeFilterCount}
                </span>
              )}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side={tooltipSide} sideOffset={6}>
          {hasAnyFilter
            ? t('auto.components.sidebar.SidebarFilter.ee240a39eb', 'Edit filters')
            : t('auto.components.sidebar.SidebarFilter.f506a1262a', 'Filter workspaces')}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side={contentSide}
        align="start"
        sideOffset={8}
        className="w-72"
        data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
      >
        <FilterToggleRow
          icon={<Moon className="size-3.5" />}
          label={t('auto.components.sidebar.SidebarFilter.638a2d221d', 'Hide sleeping')}
          checked={!showSleepingWorkspaces}
          onChange={(hideSleeping) => setShowSleepingWorkspaces(!hideSleeping)}
          shortcutLabel={isUnassignedShortcutLabel(sleepingShortcut) ? undefined : sleepingShortcut}
        />
        {/* Show the exemption only while its parent sleeping-workspace filter can use it. */}
        {!showSleepingWorkspaces && (
          <FilterToggleRow
            indented
            icon={<GitBranch className="size-3.5" />}
            label={t(
              'auto.components.sidebar.SidebarFilter.keepDefaultBranch',
              'Except default branch'
            )}
            ariaLabel={t(
              'auto.components.sidebar.SidebarFilter.keepDefaultBranchAria',
              'Keep the default branch visible while hiding sleeping workspaces'
            )}
            checked={alwaysShowDefaultBranchWorkspace}
            onChange={setAlwaysShowDefaultBranchWorkspace}
          />
        )}
        <FilterToggleRow
          icon={<GitBranch className="size-3.5" />}
          label={t('auto.components.sidebar.SidebarFilter.e5cb32a898', 'Hide default branch')}
          checked={hideDefaultBranchWorkspace}
          onChange={setHideDefaultBranchWorkspace}
        />
        <FilterToggleRow
          icon={<CalendarClock className="size-3.5" />}
          label={t(
            'auto.components.sidebar.SidebarFilter.automationCreated',
            'Hide automation-created'
          )}
          checked={hideAutomationGeneratedWorkspaces}
          onChange={setHideAutomationGeneratedWorkspaces}
        />
        <FilterToggleRow
          icon={<SquareTerminal className="size-3.5" />}
          label={t('auto.components.sidebar.SidebarFilter.cliCreated', 'Hide CLI-created')}
          checked={hideCliCreatedWorkspaces}
          onChange={setHideCliCreatedWorkspaces}
        />
        <FilterToggleRow
          icon={<GitCommitHorizontal className="size-3.5" />}
          label={t('auto.components.sidebar.SidebarFilter.detachedHead', 'Hide detached HEAD')}
          checked={hideDetachedHeadWorkspaces}
          onChange={setHideDetachedHeadWorkspaces}
        />

        {canFilterRepos && (
          <>
            <DropdownMenuSeparator />
            <div className="flex items-center justify-between px-2 py-1">
              <span className="text-[11px] font-semibold tracking-wide uppercase text-muted-foreground">
                {t('auto.components.sidebar.SidebarFilter.5f7085a077', 'Projects')}
                {hasRepoFilter && (
                  <span className="ml-1.5 normal-case tracking-normal font-medium text-foreground">
                    · {selectedCount}
                  </span>
                )}
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={selectAllRepos}
                  className="rounded-full px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40 disabled:hover:bg-transparent"
                  disabled={allSelected}
                >
                  {t('auto.components.sidebar.SidebarFilter.139877b384', 'Select all')}
                </button>
                <button
                  type="button"
                  onClick={clearRepos}
                  className="rounded-full px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40 disabled:hover:bg-transparent"
                  disabled={!hasRepoFilter}
                >
                  {t('auto.components.sidebar.SidebarFilter.779b7ba05d', 'Clear')}
                </button>
              </div>
            </div>

            <Command
              shouldFilter={false}
              value={commandValue}
              onValueChange={setCommandValueOverride}
              className="bg-transparent"
            >
              <CommandInput
                autoFocus
                placeholder={t(
                  'auto.components.sidebar.SidebarFilter.489d1c8c9f',
                  'Search projects...'
                )}
                value={query}
                onValueChange={(nextQuery) => {
                  // Reset keyboard selection when typing produces a new result list.
                  setCommandValueOverride(null)
                  setQuery(nextQuery)
                }}
                onKeyDown={(event) => event.stopPropagation()}
                className="h-8 py-2 text-xs"
                wrapperClassName="mx-1 rounded-[7px] border border-border/70 px-2"
                iconClassName="h-3.5 w-3.5"
              />
              <CommandList className="max-h-64 py-1">
                <CommandEmpty className="py-4 text-[11px]">
                  {t('auto.components.sidebar.SidebarFilter.b9e8802e73', 'No projects match')}
                </CommandEmpty>
                {filteredEntries.map((entry) => {
                  const checked = selectedEntryKeySet.has(entry.key)
                  return (
                    <CommandItem
                      key={entry.key}
                      value={entry.key}
                      onSelect={() => handleToggleEntry(entry)}
                      className="mx-1 my-0.5 items-center gap-2 rounded-[7px] px-2 py-1 text-[12px] leading-5 font-medium data-[selected=true]:bg-black/8 dark:data-[selected=true]:bg-white/14"
                    >
                      <span className="inline-flex min-w-0 flex-1 items-center gap-1.5">
                        <RepoBadgeLabel
                          name={entry.label}
                          color={entry.repo.badgeColor}
                          className="max-w-full"
                        />
                        {entry.repos.every((repo) => repo.connectionId) && (
                          <span className="shrink-0 inline-flex items-center gap-0.5 rounded bg-muted px-1 py-0.5 text-[9px] font-medium leading-none text-muted-foreground">
                            <Server className="size-2.5" />
                            {t('auto.components.sidebar.SidebarFilter.81ded53722', 'SSH')}
                          </span>
                        )}
                      </span>
                      {checked && (
                        <Check className="size-3 shrink-0 text-primary" strokeWidth={3} />
                      )}
                    </CommandItem>
                  )
                })}
              </CommandList>
            </Command>
          </>
        )}

        <DropdownMenuSeparator />
        {/* Keep Add project visible even when the project-filter section disappears at zero/one projects. */}
        <div className="flex items-center justify-between gap-1 px-1 py-1">
          {hasAnyFilter ? (
            <button
              type="button"
              onClick={clearAll}
              className="rounded-[5px] px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {t('auto.components.sidebar.SidebarFilter.92a23e6d07', 'Reset filters')}
            </button>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={() => addRepo()}
            className="inline-flex items-center gap-1.5 rounded-[5px] px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <FolderPlus className="size-3.5" />
            {t('auto.components.sidebar.SidebarFilter.e3b3898218', 'Add project')}
          </button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
})

export default SidebarFilter
