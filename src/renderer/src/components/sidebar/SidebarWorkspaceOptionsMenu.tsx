import React, { useCallback, useMemo, useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { AgentActivityDisplayMode } from '../../../../shared/types'
import { DEFAULT_SHOW_SLEEPING_WORKSPACES } from '../../../../shared/constants'
import SidebarRepositoryFilterSection from './SidebarRepositoryFilterSection'
import SidebarWorkspaceFilterSection from './SidebarWorkspaceFilterSection'
import { getSidebarHostVisibilityLabel, shouldShowHostScopeControls } from './sidebar-host-options'
import { useSidebarHostScopeOptions } from './use-sidebar-host-scope-options'
import { SidebarHostScopeMenuSection } from './SidebarHostScopeMenuSection'
import {
  AGENT_ACTIVITY_DISPLAY_OPTIONS,
  CARD_LAYOUT_OPTIONS,
  PROJECT_ORDER_OPTIONS,
  PROPERTY_OPTIONS,
  SORT_OPTIONS
} from './sidebar-workspace-option-items'
import { translate } from '@/i18n/i18n'
import { SidebarGroupByToggle } from './SidebarGroupByToggle'

type SidebarWorkspaceOptionsMenuProps = {
  preserveWorkspaceBoardOpen?: boolean
  onMenuOpenChange?: (open: boolean) => void
}

const SidebarWorkspaceOptionsMenu = React.memo(function SidebarWorkspaceOptionsMenu({
  preserveWorkspaceBoardOpen = false,
  onMenuOpenChange
}: SidebarWorkspaceOptionsMenuProps) {
  const showSleepingWorkspaces = useAppStore((s) => s.showSleepingWorkspaces)
  const hideDefaultBranchWorkspace = useAppStore((s) => s.hideDefaultBranchWorkspace)
  const filterRepoIds = useAppStore((s) => s.filterRepoIds)
  const repos = useAppStore((s) => s.repos)
  const worktreeCardProperties = useAppStore((s) => s.worktreeCardProperties)
  const toggleWorktreeCardProperty = useAppStore((s) => s.toggleWorktreeCardProperty)
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const setWorkspaceHostScope = useAppStore((s) => s.setWorkspaceHostScope)
  const visibleWorkspaceHostIds = useAppStore((s) => s.visibleWorkspaceHostIds)
  const setVisibleWorkspaceHostIds = useAppStore((s) => s.setVisibleWorkspaceHostIds)
  const agentActivityDisplayMode = useAppStore((s) => s.agentActivityDisplayMode)
  const setAgentActivityDisplayMode = useAppStore((s) => s.setAgentActivityDisplayMode)
  const sortBy = useAppStore((s) => s.sortBy)
  const setSortBy = useAppStore((s) => s.setSortBy)
  const groupBy = useAppStore((s) => s.groupBy)
  const setGroupBy = useAppStore((s) => s.setGroupBy)
  const projectOrderBy = useAppStore((s) => s.projectOrderBy)
  const setProjectOrderBy = useAppStore((s) => s.setProjectOrderBy)

  const [open, setOpen] = useState(false)
  const { hostOptions } = useSidebarHostScopeOptions()
  const showHostScopeControls = shouldShowHostScopeControls(hostOptions)

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next)
      onMenuOpenChange?.(next)
    },
    [onMenuOpenChange]
  )

  // Why: derive from current repos so stale ids (e.g. lingering after a repo
  // is removed) don't inflate counts or falsely signal an applied filter.
  const selectedCount = useMemo(() => {
    let count = 0
    for (const repo of repos) {
      if (filterRepoIds.includes(repo.id)) {
        count += 1
      }
    }
    return count
  }, [repos, filterRepoIds])
  const hasRepoFilter = selectedCount > 0
  const hasSleepingFilter = showSleepingWorkspaces !== DEFAULT_SHOW_SLEEPING_WORKSPACES
  const hasHostVisibilityFilter = visibleWorkspaceHostIds !== null
  const hasAnyFilter =
    hasSleepingFilter || hideDefaultBranchWorkspace || hasRepoFilter || hasHostVisibilityFilter
  const activeFilterCount =
    (hasSleepingFilter ? 1 : 0) +
    (hideDefaultBranchWorkspace ? 1 : 0) +
    (hasHostVisibilityFilter ? 1 : 0) +
    selectedCount
  const activeFilterLabel = `${activeFilterCount} ${activeFilterCount === 1 ? 'filter' : 'filters'}`
  const sortLabel = SORT_OPTIONS.find((opt) => opt.id === sortBy)?.label ?? 'Sort'
  const projectOrderLabel =
    PROJECT_ORDER_OPTIONS.find((opt) => opt.id === projectOrderBy)?.label ?? 'Manual'
  const hostVisibilityLabel = getSidebarHostVisibilityLabel(visibleWorkspaceHostIds, hostOptions)
  const cardLayout = settings?.compactWorktreeCards ? 'compact' : 'detailed'
  const cardLayoutLabel =
    CARD_LAYOUT_OPTIONS.find((opt) => opt.id === cardLayout)?.label ?? 'Detailed'
  const visiblePropertyCount = PROPERTY_OPTIONS.filter((opt) =>
    worktreeCardProperties.includes(opt.id)
  ).length

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              className="relative text-muted-foreground"
              aria-label={
                hasAnyFilter
                  ? translate(
                      'auto.components.sidebar.SidebarWorkspaceOptionsMenu.bc96dbd041',
                      'Workspace options ({{value0}} active)',
                      { value0: activeFilterLabel }
                    )
                  : translate(
                      'auto.components.sidebar.SidebarWorkspaceOptionsMenu.9919ae1082',
                      'Workspace options'
                    )
              }
              data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
            >
              <SlidersHorizontal className="size-3.5" strokeWidth={2.25} />
              {hasAnyFilter && (
                // Why: this combined options button now owns filtering, so it
                // needs the same at-a-glance signal that the old filter button had.
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
        <TooltipContent side="bottom" sideOffset={6}>
          {hasAnyFilter
            ? translate(
                'auto.components.sidebar.SidebarWorkspaceOptionsMenu.bc96dbd041',
                'Workspace options ({{value0}})',
                { value0: activeFilterLabel }
              )
            : translate(
                'auto.components.sidebar.SidebarWorkspaceOptionsMenu.9919ae1082',
                'Workspace options'
              )}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="right"
        align="start"
        sideOffset={8}
        className="w-72 pb-2"
        data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
      >
        {showHostScopeControls && (
          <SidebarHostScopeMenuSection
            hostOptionsCount={hostOptions.length}
            hostVisibilityLabel={hostVisibilityLabel}
            hostOptions={hostOptions}
            preserveWorkspaceBoardOpen={preserveWorkspaceBoardOpen}
            setWorkspaceHostScope={setWorkspaceHostScope}
            visibleWorkspaceHostIds={visibleWorkspaceHostIds}
            setVisibleWorkspaceHostIds={setVisibleWorkspaceHostIds}
          />
        )}

        <DropdownMenuLabel>
          {translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.dc0bb670bc', 'Group by')}
        </DropdownMenuLabel>
        <div className="px-2 pt-0.5 pb-1">
          <SidebarGroupByToggle groupBy={groupBy} setGroupBy={setGroupBy} />
        </div>

        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <span className="flex flex-1 items-center justify-between">
              <span>
                {translate(
                  'auto.components.sidebar.SidebarWorkspaceOptionsMenu.7bada3b1ab',
                  'Sort by'
                )}
              </span>
              <span className="text-[11px] font-medium text-muted-foreground">{sortLabel}</span>
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent
            className="w-44"
            data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
          >
            <DropdownMenuRadioGroup
              value={sortBy}
              onValueChange={(v) => setSortBy(v as typeof sortBy)}
            >
              {SORT_OPTIONS.map((opt) => {
                const radioItem = (
                  <DropdownMenuRadioItem
                    key={opt.id}
                    value={opt.id}
                    // Keep the menu open so people can compare sort modes and
                    // toggle card properties without reopening the same panel.
                    onSelect={(e) => e.preventDefault()}
                  >
                    {opt.label}
                  </DropdownMenuRadioItem>
                )
                if (!opt.description) {
                  return radioItem
                }
                return (
                  <Tooltip key={opt.id}>
                    <TooltipTrigger asChild>{radioItem}</TooltipTrigger>
                    <TooltipContent side="right" sideOffset={6}>
                      {opt.description}
                    </TooltipContent>
                  </Tooltip>
                )
              })}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {/* Why: project order only has a visible effect when grouping by
            project; hide it in none/status/PR modes to avoid a dead control. */}
        {groupBy === 'repo' && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <span className="flex flex-1 items-center justify-between">
                <span>
                  {translate(
                    'auto.components.sidebar.SidebarWorkspaceOptionsMenu.09faabd875',
                    'Project order'
                  )}
                </span>
                <span className="text-[11px] font-medium text-muted-foreground">
                  {projectOrderLabel}
                </span>
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent
              className="w-44"
              data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
            >
              <DropdownMenuRadioGroup
                value={projectOrderBy}
                onValueChange={(v) => setProjectOrderBy(v as typeof projectOrderBy)}
              >
                {PROJECT_ORDER_OPTIONS.map((opt) => (
                  <Tooltip key={opt.id}>
                    <TooltipTrigger asChild>
                      <DropdownMenuRadioItem
                        value={opt.id}
                        // Keep the menu open so people can compare order modes.
                        onSelect={(e) => e.preventDefault()}
                      >
                        {opt.label}
                      </DropdownMenuRadioItem>
                    </TooltipTrigger>
                    <TooltipContent side="right" sideOffset={6}>
                      {opt.description}
                    </TooltipContent>
                  </Tooltip>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <span className="flex flex-1 items-center justify-between">
              <span>
                {translate(
                  'auto.components.sidebar.SidebarWorkspaceOptionsMenu.320b675c9a',
                  'Card layout'
                )}
              </span>
              <span className="text-[11px] font-medium text-muted-foreground">
                {cardLayoutLabel}
              </span>
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent
            className="w-44"
            data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
          >
            <DropdownMenuRadioGroup
              value={cardLayout}
              onValueChange={(value) => {
                void updateSettings({
                  compactWorktreeCards: value === 'compact'
                })
              }}
            >
              {CARD_LAYOUT_OPTIONS.map((opt) => (
                <DropdownMenuRadioItem
                  key={opt.id}
                  value={opt.id}
                  onSelect={(e) => e.preventDefault()}
                >
                  {opt.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <span className="flex flex-1 items-center justify-between">
              <span>
                {translate(
                  'auto.components.sidebar.SidebarWorkspaceOptionsMenu.ba87080fb7',
                  'Show properties'
                )}
              </span>
              {cardLayout === 'compact' ? (
                <span className="text-[11px] font-medium text-muted-foreground">
                  {translate(
                    'auto.components.sidebar.SidebarWorkspaceOptionsMenu.3d4b9c4997',
                    'Hover'
                  )}
                </span>
              ) : visiblePropertyCount > 0 ? (
                <span className="text-[11px] font-medium text-muted-foreground">
                  {visiblePropertyCount}
                </span>
              ) : null}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent
            className="w-48"
            data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
          >
            {PROPERTY_OPTIONS.map((opt) => (
              <DropdownMenuCheckboxItem
                key={opt.id}
                checked={worktreeCardProperties.includes(opt.id)}
                onCheckedChange={() => toggleWorktreeCardProperty(opt.id)}
                onSelect={(e) => e.preventDefault()}
              >
                {opt.label}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
              {translate(
                'auto.components.sidebar.SidebarWorkspaceOptionsMenu.95c9754653',
                'Agent activity layout'
              )}
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={agentActivityDisplayMode}
              onValueChange={(value) =>
                setAgentActivityDisplayMode(value as AgentActivityDisplayMode)
              }
            >
              {AGENT_ACTIVITY_DISPLAY_OPTIONS.map((opt) => (
                <DropdownMenuRadioItem
                  key={opt.id}
                  value={opt.id}
                  onSelect={(e) => e.preventDefault()}
                >
                  {opt.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSeparator />
        <SidebarWorkspaceFilterSection />

        <DropdownMenuSeparator />
        <SidebarRepositoryFilterSection />
      </DropdownMenuContent>
    </DropdownMenu>
  )
})

export default SidebarWorkspaceOptionsMenu
