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
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { AgentActivityDisplayMode, WorktreeCardProperty } from '../../../../shared/types'
import { DEFAULT_SHOW_SLEEPING_WORKSPACES } from '../../../../shared/constants'
import SidebarRepositoryFilterSection from './SidebarRepositoryFilterSection'
import SidebarWorkspaceFilterSection from './SidebarWorkspaceFilterSection'
import { translate } from '@/i18n/i18n'

type SidebarWorkspaceOptionsMenuProps = {
  preserveWorkspaceBoardOpen?: boolean
  onMenuOpenChange?: (open: boolean) => void
}

const GROUP_BY_OPTIONS = [
  { id: 'none', label: translate("auto.components.sidebar.SidebarWorkspaceOptionsMenu.c2c7a45cda", "None") },
  { id: 'workspace-status', label: translate("auto.components.sidebar.SidebarWorkspaceOptionsMenu.e029a2d775", "Status") },
  { id: 'pr-status', label: translate("auto.components.sidebar.SidebarWorkspaceOptionsMenu.0f9b959b31", "PR") },
  { id: 'repo', label: translate("auto.components.sidebar.SidebarWorkspaceOptionsMenu.2170d553cf", "Project") }
] as const

const CARD_LAYOUT_OPTIONS = [
  { id: 'detailed', label: translate("auto.components.sidebar.SidebarWorkspaceOptionsMenu.cc17bd443b", "Detailed") },
  { id: 'compact', label: translate("auto.components.sidebar.SidebarWorkspaceOptionsMenu.25105b28cb", "Compact") }
] as const

const PROPERTY_OPTIONS: { id: WorktreeCardProperty; label: string }[] = [
  { id: 'issue', label: translate("auto.components.sidebar.SidebarWorkspaceOptionsMenu.91dfc653e8", "GitHub ticket") },
  { id: 'linear-issue', label: translate("auto.components.sidebar.SidebarWorkspaceOptionsMenu.ca4d3c522e", "Linear issue") },
  { id: 'pr', label: translate("auto.components.sidebar.SidebarWorkspaceOptionsMenu.b8dcc6f321", "PR/MR link") },
  { id: 'comment', label: translate("auto.components.sidebar.SidebarWorkspaceOptionsMenu.26c71e536c", "Notes") },
  { id: 'ports', label: translate("auto.components.sidebar.SidebarWorkspaceOptionsMenu.b64d8bcca0", "Ports") },
  // Why: toggles the inline "Agent activity" list rendered below each
  // workspace card body (see WorktreeCard -> WorktreeCardAgents). Off hides
  // the list; there is no alternate surface.
  { id: 'inline-agents', label: translate("auto.components.sidebar.SidebarWorkspaceOptionsMenu.d7084e8bc8", "Agent activity") }
]

const AGENT_ACTIVITY_DISPLAY_OPTIONS: { id: AgentActivityDisplayMode; label: string }[] = [
  { id: 'compact', label: translate("auto.components.sidebar.SidebarWorkspaceOptionsMenu.25105b28cb", "Compact") },
  { id: 'full', label: translate("auto.components.sidebar.SidebarWorkspaceOptionsMenu.2a81e07366", "Full list") }
]

const SORT_OPTIONS = [
  { id: 'name', label: translate("auto.components.sidebar.SidebarWorkspaceOptionsMenu.3728165cdd", "Name"), description: null },
  {
    id: 'smart',
    label: translate("auto.components.sidebar.SidebarWorkspaceOptionsMenu.503462f2b4", "Agent Activity"),
    description: translate("auto.components.sidebar.SidebarWorkspaceOptionsMenu.b759bb87ee", "Agents that need attention, then most recent activity.")
  },
  { id: 'recent', label: translate("auto.components.sidebar.SidebarWorkspaceOptionsMenu.b451c8b162", "Recent"), description: null },
  { id: 'repo', label: translate("auto.components.sidebar.SidebarWorkspaceOptionsMenu.2170d553cf", "Project"), description: null },
  {
    id: 'manual',
    label: translate("auto.components.sidebar.SidebarWorkspaceOptionsMenu.7b316bdd51", "Manual"),
    description: translate("auto.components.sidebar.SidebarWorkspaceOptionsMenu.7153d07485", "Drag workspaces to arrange them within each group.")
  }
] as const

const PROJECT_ORDER_OPTIONS = [
  { id: 'manual', label: translate("auto.components.sidebar.SidebarWorkspaceOptionsMenu.7b316bdd51", "Manual"), description: translate("auto.components.sidebar.SidebarWorkspaceOptionsMenu.6664282a7b", "Drag projects to arrange them") },
  { id: 'recent', label: translate("auto.components.sidebar.SidebarWorkspaceOptionsMenu.b451c8b162", "Recent"), description: translate("auto.components.sidebar.SidebarWorkspaceOptionsMenu.af9249c505", "Most recent workspace activity") }
] as const

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
  const agentActivityDisplayMode = useAppStore((s) => s.agentActivityDisplayMode)
  const setAgentActivityDisplayMode = useAppStore((s) => s.setAgentActivityDisplayMode)
  const sortBy = useAppStore((s) => s.sortBy)
  const setSortBy = useAppStore((s) => s.setSortBy)
  const groupBy = useAppStore((s) => s.groupBy)
  const setGroupBy = useAppStore((s) => s.setGroupBy)
  const projectOrderBy = useAppStore((s) => s.projectOrderBy)
  const setProjectOrderBy = useAppStore((s) => s.setProjectOrderBy)

  const [open, setOpen] = useState(false)

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
  const hasAnyFilter = hasSleepingFilter || hideDefaultBranchWorkspace || hasRepoFilter
  const activeFilterCount =
    (hasSleepingFilter ? 1 : 0) + (hideDefaultBranchWorkspace ? 1 : 0) + selectedCount
  const activeFilterLabel = `${activeFilterCount} ${activeFilterCount === 1 ? 'filter' : 'filters'}`
  const sortLabel = SORT_OPTIONS.find((opt) => opt.id === sortBy)?.label ?? 'Sort'
  const projectOrderLabel =
    PROJECT_ORDER_OPTIONS.find((opt) => opt.id === projectOrderBy)?.label ?? 'Manual'
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
                  ? translate("auto.components.sidebar.SidebarWorkspaceOptionsMenu.bc96dbd041", "Workspace options ({{value0}} active)", { value0: activeFilterLabel })
                  : translate("auto.components.sidebar.SidebarWorkspaceOptionsMenu.9919ae1082", "Workspace options")
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
          {hasAnyFilter ? translate("auto.components.sidebar.SidebarWorkspaceOptionsMenu.bc96dbd041", "Workspace options ({{value0}})", { value0: activeFilterLabel }) : translate("auto.components.sidebar.SidebarWorkspaceOptionsMenu.9919ae1082", "Workspace options")}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="right"
        align="start"
        sideOffset={8}
        className="w-72 pb-2"
        data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
      >
        <DropdownMenuLabel>{translate("auto.components.sidebar.SidebarWorkspaceOptionsMenu.dc0bb670bc", "Group by")}</DropdownMenuLabel>
        <div className="px-2 pt-0.5 pb-1">
          <ToggleGroup
            type="single"
            value={groupBy}
            onValueChange={(v) => {
              if (v) {
                setGroupBy(v as typeof groupBy)
              }
            }}
            variant="outline"
            size="sm"
            className="h-6 w-full justify-stretch"
          >
            {GROUP_BY_OPTIONS.map((opt) => (
              <ToggleGroupItem
                key={opt.id}
                value={opt.id}
                className="h-6 grow basis-0 px-1 text-[10px] data-[state=on]:bg-foreground/10 data-[state=on]:font-semibold data-[state=on]:text-foreground"
              >
                {opt.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>

        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <span className="flex flex-1 items-center justify-between">
              <span>{translate("auto.components.sidebar.SidebarWorkspaceOptionsMenu.7bada3b1ab", "Sort by")}</span>
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
        {groupBy === "repo" && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <span className="flex flex-1 items-center justify-between">
                <span>{translate("auto.components.sidebar.SidebarWorkspaceOptionsMenu.09faabd875", "Project order")}</span>
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
              <span>{translate("auto.components.sidebar.SidebarWorkspaceOptionsMenu.320b675c9a", "Card layout")}</span>
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
              <span>{translate("auto.components.sidebar.SidebarWorkspaceOptionsMenu.ba87080fb7", "Show properties")}</span>
              {cardLayout === "compact" ? (
                <span className="text-[11px] font-medium text-muted-foreground">{translate("auto.components.sidebar.SidebarWorkspaceOptionsMenu.3d4b9c4997", "Hover")}</span>
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
              {translate("auto.components.sidebar.SidebarWorkspaceOptionsMenu.95c9754653", "Agent activity layout")}</DropdownMenuLabel>
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
