import { useMemo, type JSX } from 'react'
import { useAppStore } from '@/store'
import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DEFAULT_SHOW_SLEEPING_WORKSPACES } from '../../../../shared/constants'
import { isSleepingSweepExemptionNarrowingList } from './visible-worktrees'
import SidebarRepositoryFilterSection from './SidebarRepositoryFilterSection'
import SidebarWorkspaceFilterSection from './SidebarWorkspaceFilterSection'
import { getSidebarHostVisibilityLabel, shouldShowHostScopeControls } from './sidebar-host-options'
import { useSidebarHostScopeOptions } from './use-sidebar-host-scope-options'
import { SidebarHostScopeMenuSection } from './SidebarHostScopeMenuSection'
import { PROJECT_ORDER_OPTIONS, SORT_OPTIONS } from './sidebar-workspace-option-items'
import { WorktreeCardDisplayMenuSection } from './WorktreeCardDisplayMenuSection'
import { translate } from '@/i18n/i18n'
import { SidebarGroupByToggle } from './SidebarGroupByToggle'

export function useWorkspaceOptionsFilterBadge(): {
  hasAnyFilter: boolean
  activeFilterCount: number
  activeFilterLabel: string
} {
  const showSleepingWorkspaces = useAppStore((s) => s.showSleepingWorkspaces)
  const hideDefaultBranchWorkspace = useAppStore((s) => s.hideDefaultBranchWorkspace)
  const hideAutomationGeneratedWorkspaces = useAppStore((s) => s.hideAutomationGeneratedWorkspaces)
  const hideCliCreatedWorkspaces = useAppStore((s) => s.hideCliCreatedWorkspaces)
  const hideDetachedHeadWorkspaces = useAppStore((s) => s.hideDetachedHeadWorkspaces)
  const hideWorkspacesFromOtherDevices = useAppStore((s) => s.hideWorkspacesFromOtherDevices)
  const alwaysShowDefaultBranchWorkspace = useAppStore((s) => s.alwaysShowDefaultBranchWorkspace)
  const filterRepoIds = useAppStore((s) => s.filterRepoIds)
  const repos = useAppStore((s) => s.repos)
  const visibleWorkspaceHostIds = useAppStore((s) => s.visibleWorkspaceHostIds)

  const selectedCount = useMemo(() => {
    let count = 0
    for (const repo of repos) {
      if (filterRepoIds.includes(repo.id)) {
        count += 1
      }
    }
    return count
  }, [repos, filterRepoIds])

  const hasSleepingFilter = showSleepingWorkspaces !== DEFAULT_SHOW_SLEEPING_WORKSPACES
  const hasSleepingExemptionFilter = isSleepingSweepExemptionNarrowingList(
    showSleepingWorkspaces,
    alwaysShowDefaultBranchWorkspace
  )
  const hasRepoFilter = selectedCount > 0
  const hasHostVisibilityFilter = visibleWorkspaceHostIds !== null
  const hasAnyFilter =
    hasSleepingFilter ||
    hideDefaultBranchWorkspace ||
    hideAutomationGeneratedWorkspaces ||
    hideCliCreatedWorkspaces ||
    hideDetachedHeadWorkspaces ||
    hideWorkspacesFromOtherDevices ||
    hasSleepingExemptionFilter ||
    hasRepoFilter ||
    hasHostVisibilityFilter
  const activeFilterCount =
    (hasSleepingFilter ? 1 : 0) +
    (hideDefaultBranchWorkspace ? 1 : 0) +
    (hideAutomationGeneratedWorkspaces ? 1 : 0) +
    (hideCliCreatedWorkspaces ? 1 : 0) +
    (hideDetachedHeadWorkspaces ? 1 : 0) +
    (hideWorkspacesFromOtherDevices ? 1 : 0) +
    (hasSleepingExemptionFilter ? 1 : 0) +
    (hasHostVisibilityFilter ? 1 : 0) +
    selectedCount

  return {
    hasAnyFilter,
    activeFilterCount,
    activeFilterLabel: `${activeFilterCount} ${activeFilterCount === 1 ? 'filter' : 'filters'}`
  }
}

export function WorkspaceOptionsMenuItems({
  preserveWorkspaceBoardOpen = false
}: {
  preserveWorkspaceBoardOpen?: boolean
}): JSX.Element {
  const repos = useAppStore((s) => s.repos)
  const setWorkspaceHostScope = useAppStore((s) => s.setWorkspaceHostScope)
  const visibleWorkspaceHostIds = useAppStore((s) => s.visibleWorkspaceHostIds)
  const setVisibleWorkspaceHostIds = useAppStore((s) => s.setVisibleWorkspaceHostIds)
  const sortBy = useAppStore((s) => s.sortBy)
  const setSortBy = useAppStore((s) => s.setSortBy)
  const groupBy = useAppStore((s) => s.groupBy)
  const setGroupBy = useAppStore((s) => s.setGroupBy)
  const projectOrderBy = useAppStore((s) => s.projectOrderBy)
  const setProjectOrderBy = useAppStore((s) => s.setProjectOrderBy)
  const { hostOptions } = useSidebarHostScopeOptions()
  const showHostScopeControls = shouldShowHostScopeControls(hostOptions)
  const sortLabel = SORT_OPTIONS.find((opt) => opt.id === sortBy)?.label ?? 'Sort'
  const projectOrderLabel =
    PROJECT_ORDER_OPTIONS.find((opt) => opt.id === projectOrderBy)?.label ?? 'Manual'
  const hostVisibilityLabel = getSidebarHostVisibilityLabel(visibleWorkspaceHostIds, hostOptions)
  const boardAttr = preserveWorkspaceBoardOpen ? '' : undefined

  return (
    <>
      <DropdownMenuLabel className="pb-0 text-sm text-foreground">
        {translate(
          'auto.components.sidebar.SidebarWorkspaceOptionsMenu.workspaceOptions',
          'Workspace options'
        )}
      </DropdownMenuLabel>
      {/* Why: host + project filters share one section and the same single-row
          shell as Sort by (label left, value right) so the menu stays flat. */}
      {(showHostScopeControls || repos.length > 1) && (
        <>
          <DropdownMenuLabel>
            {translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.showSection', 'Show')}
          </DropdownMenuLabel>
          {showHostScopeControls && (
            <SidebarHostScopeMenuSection
              hostVisibilityLabel={hostVisibilityLabel}
              hostOptions={hostOptions}
              preserveWorkspaceBoardOpen={preserveWorkspaceBoardOpen}
              setWorkspaceHostScope={setWorkspaceHostScope}
              visibleWorkspaceHostIds={visibleWorkspaceHostIds}
              setVisibleWorkspaceHostIds={setVisibleWorkspaceHostIds}
            />
          )}
          <SidebarRepositoryFilterSection preserveWorkspaceBoardOpen={preserveWorkspaceBoardOpen} />
          <DropdownMenuSeparator />
        </>
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
        <DropdownMenuSubContent className="w-44" data-workspace-board-preserve-open={boardAttr}>
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
          <DropdownMenuSubContent className="w-44" data-workspace-board-preserve-open={boardAttr}>
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

      <WorktreeCardDisplayMenuSection preserveWorkspaceBoardOpen={preserveWorkspaceBoardOpen} />
      <DropdownMenuSeparator />
      <SidebarWorkspaceFilterSection />
    </>
  )
}
