import { Fragment, useMemo, type ComponentType, type JSX } from 'react'
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
import {
  countActiveWorkspaceFilters,
  formatActiveFilterLabel
} from '../../../../shared/workspace-view/workspace-row-filters'
import { useShallow } from 'zustand/react/shallow'
import { selectSidebarFilterState, sidebarWorkspaceRowFilters } from './sidebar-filter-actions'
import SidebarRepositoryFilterSection from './SidebarRepositoryFilterSection'
import { WorkspaceFilterOptionRow } from './workspace-filter-option-row'
import {
  getSidebarHostVisibilityLabel,
  shouldShowHostScopeControls,
  type SidebarHostOption
} from './sidebar-host-options'
import { useSidebarHostScopeOptions } from './use-sidebar-host-scope-options'
import { SidebarHostScopeMenuSection } from './SidebarHostScopeMenuSection'
import { PROJECT_ORDER_OPTIONS, SORT_OPTIONS } from './sidebar-workspace-option-items'
import {
  WorktreeCardDisplayMenuItem,
  WorktreeCardLayoutMenuItem,
  WorktreeCardPropertiesMenuItem
} from './worktree-card-option-items'
import {
  getShownWorkspaceViewSections,
  type WorkspaceViewOptionKey,
  type WorkspaceViewSection
} from '../../../../shared/workspace-view/workspace-view-options'
import { translate } from '@/i18n/i18n'
import { SidebarGroupByToggle } from './SidebarGroupByToggle'

export function useWorkspaceOptionsFilterBadge(): {
  hasAnyFilter: boolean
  activeFilterCount: number
  activeFilterLabel: string
} {
  const filterState = useAppStore(useShallow(selectSidebarFilterState))
  const repos = useAppStore((s) => s.repos)
  const activeFilterCount = useMemo(
    () =>
      countActiveWorkspaceFilters(
        sidebarWorkspaceRowFilters(filterState),
        repos.map((repo) => repo.id)
      ),
    [filterState, repos]
  )
  return {
    hasAnyFilter: activeFilterCount > 0,
    activeFilterCount,
    activeFilterLabel: formatActiveFilterLabel(activeFilterCount)
  }
}

type OptionItemProps = {
  preserveWorkspaceBoardOpen: boolean
  hostOptions: SidebarHostOption[]
}

function HostsOptionItem({
  preserveWorkspaceBoardOpen,
  hostOptions
}: OptionItemProps): JSX.Element {
  const setWorkspaceHostScope = useAppStore((s) => s.setWorkspaceHostScope)
  const visibleWorkspaceHostIds = useAppStore((s) => s.visibleWorkspaceHostIds)
  const setVisibleWorkspaceHostIds = useAppStore((s) => s.setVisibleWorkspaceHostIds)
  return (
    <SidebarHostScopeMenuSection
      hostVisibilityLabel={getSidebarHostVisibilityLabel(visibleWorkspaceHostIds, hostOptions)}
      hostOptions={hostOptions}
      preserveWorkspaceBoardOpen={preserveWorkspaceBoardOpen}
      setWorkspaceHostScope={setWorkspaceHostScope}
      visibleWorkspaceHostIds={visibleWorkspaceHostIds}
      setVisibleWorkspaceHostIds={setVisibleWorkspaceHostIds}
    />
  )
}

function GroupByOptionItem(): JSX.Element {
  const groupBy = useAppStore((s) => s.groupBy)
  const setGroupBy = useAppStore((s) => s.setGroupBy)
  return (
    <div className="px-2 pt-0.5 pb-1">
      <SidebarGroupByToggle groupBy={groupBy} setGroupBy={setGroupBy} />
    </div>
  )
}

function SortByOptionItem({ preserveWorkspaceBoardOpen }: OptionItemProps): JSX.Element {
  const sortBy = useAppStore((s) => s.sortBy)
  const setSortBy = useAppStore((s) => s.setSortBy)
  const sortLabel = SORT_OPTIONS.find((opt) => opt.id === sortBy)?.label ?? 'Sort'
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <span className="flex flex-1 items-center justify-between">
          <span>
            {translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.7bada3b1ab', 'Sort by')}
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
          onValueChange={(value) => {
            const next = SORT_OPTIONS.find((opt) => opt.id === value)
            if (next) {
              setSortBy(next.id)
            }
          }}
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
  )
}

function ProjectOrderOptionItem({ preserveWorkspaceBoardOpen }: OptionItemProps): JSX.Element {
  const projectOrderBy = useAppStore((s) => s.projectOrderBy)
  const setProjectOrderBy = useAppStore((s) => s.setProjectOrderBy)
  const projectOrderLabel =
    PROJECT_ORDER_OPTIONS.find((opt) => opt.id === projectOrderBy)?.label ?? 'Manual'
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <span className="flex flex-1 items-center justify-between">
          <span>
            {translate(
              'auto.components.sidebar.SidebarWorkspaceOptionsMenu.09faabd875',
              'Project order'
            )}
          </span>
          <span className="text-[11px] font-medium text-muted-foreground">{projectOrderLabel}</span>
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        className="w-44"
        data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
      >
        <DropdownMenuRadioGroup
          value={projectOrderBy}
          onValueChange={(value) => {
            const next = PROJECT_ORDER_OPTIONS.find((opt) => opt.id === value)
            if (next) {
              setProjectOrderBy(next.id)
            }
          }}
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
  )
}

/** One desktop control per shared option; a new option fails to compile until it has one. */
const OPTION_ITEMS: Record<WorkspaceViewOptionKey, ComponentType<OptionItemProps>> = {
  hosts: HostsOptionItem,
  projects: SidebarRepositoryFilterSection,
  groupBy: GroupByOptionItem,
  sortBy: SortByOptionItem,
  projectOrderBy: ProjectOrderOptionItem,
  cardLayout: WorktreeCardLayoutMenuItem,
  cardProperties: WorktreeCardPropertiesMenuItem,
  cardDisplay: WorktreeCardDisplayMenuItem,
  hideSleepingWorkspaces: () => <WorkspaceFilterOptionRow optionKey="hideSleepingWorkspaces" />,
  alwaysShowDefaultBranchWorkspace: () => (
    <WorkspaceFilterOptionRow optionKey="alwaysShowDefaultBranchWorkspace" />
  ),
  hideDefaultBranchWorkspace: () => (
    <WorkspaceFilterOptionRow optionKey="hideDefaultBranchWorkspace" />
  ),
  hideAutomationGeneratedWorkspaces: () => (
    <WorkspaceFilterOptionRow optionKey="hideAutomationGeneratedWorkspaces" />
  ),
  hideCliCreatedWorkspaces: () => <WorkspaceFilterOptionRow optionKey="hideCliCreatedWorkspaces" />,
  hideWorkspacesFromOtherDevices: () => (
    <WorkspaceFilterOptionRow optionKey="hideWorkspacesFromOtherDevices" />
  ),
  hideDetachedHeadWorkspaces: () => (
    <WorkspaceFilterOptionRow optionKey="hideDetachedHeadWorkspaces" />
  )
}

function SectionHeading({ section }: { section: WorkspaceViewSection }): JSX.Element | null {
  switch (section) {
    case 'show':
      return (
        <DropdownMenuLabel>
          {translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.showSection', 'Show')}
        </DropdownMenuLabel>
      )
    case 'group':
      return (
        <DropdownMenuLabel>
          {translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.dc0bb670bc', 'Group by')}
        </DropdownMenuLabel>
      )
    case 'arrange':
      return null
    case 'filters':
      return (
        <div className="flex items-center justify-between px-2 py-1">
          <span className="text-[11px] font-semibold text-muted-foreground">
            {translate(
              'auto.components.sidebar.SidebarWorkspaceFilterSection.82594419ba',
              'Filters'
            )}
          </span>
        </div>
      )
  }
}

export function WorkspaceOptionsMenuItems({
  preserveWorkspaceBoardOpen = false
}: {
  preserveWorkspaceBoardOpen?: boolean
}): JSX.Element {
  const repoCount = useAppStore((s) => s.repos.length)
  const groupBy = useAppStore((s) => s.groupBy)
  const showSleepingWorkspaces = useAppStore((s) => s.showSleepingWorkspaces)
  const hideWorkspacesFromOtherDevices = useAppStore((s) => s.hideWorkspacesFromOtherDevices)
  const newCardStyle = useAppStore((s) => s.settings?.experimentalNewWorktreeCardStyle === true)
  const runtimeEnvironmentCount = useAppStore((s) => s.runtimeEnvironments.length)
  const runtimeEnvironmentCatalogHydrated = useAppStore((s) => s.runtimeEnvironmentCatalogHydrated)
  const { hostOptions } = useSidebarHostScopeOptions()
  const sections = getShownWorkspaceViewSections({
    groupBy,
    hideSleepingWorkspaces: !showSleepingWorkspaces,
    hideWorkspacesFromOtherDevices,
    newCardStyle,
    hasRemoteHosts: shouldShowHostScopeControls(hostOptions),
    projectCount: repoCount,
    mayHaveServerHosts: !runtimeEnvironmentCatalogHydrated || runtimeEnvironmentCount > 0
  })

  return (
    <>
      <DropdownMenuLabel className="pb-0 text-sm text-foreground">
        {translate(
          'auto.components.sidebar.SidebarWorkspaceOptionsMenu.workspaceOptions',
          'Workspace options'
        )}
      </DropdownMenuLabel>
      {sections.map(({ section, options }, index) => (
        <Fragment key={section}>
          {index > 0 && <DropdownMenuSeparator />}
          <SectionHeading section={section} />
          {options.map((option) => {
            const OptionItem = OPTION_ITEMS[option.key]
            return (
              <OptionItem
                key={option.key}
                preserveWorkspaceBoardOpen={preserveWorkspaceBoardOpen}
                hostOptions={hostOptions}
              />
            )
          })}
        </Fragment>
      ))}
    </>
  )
}
