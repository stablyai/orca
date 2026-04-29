import React, { useMemo } from 'react'
import { Plus, SlidersHorizontal } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem
} from '@/components/ui/dropdown-menu'
import type { WorktreeCardProperty } from '../../../../shared/types'

const GROUP_BY_OPTIONS = [
  { id: 'none', label: 'All' },
  { id: 'pr-status', label: 'PR Status' },
  { id: 'repo', label: 'Repo' }
] as const

const PROPERTY_OPTIONS: { id: WorktreeCardProperty; label: string }[] = [
  { id: 'status', label: 'Terminal status' },
  { id: 'unread', label: 'Unread indicator' },
  { id: 'ci', label: 'CI checks' },
  { id: 'issue', label: 'Linked issue' },
  { id: 'pr', label: 'Linked PR' },
  { id: 'comment', label: 'Comment' }
]

const SORT_OPTIONS = [
  { id: 'name', label: 'Name' },
  { id: 'smart', label: 'Smart' },
  { id: 'recent', label: 'Recent' },
  { id: 'repo', label: 'Repo' }
] as const

const AGENT_FILTER_OPTIONS = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'done', label: 'Done' }
] as const

const isMac = navigator.userAgent.includes('Mac')
const newWorktreeShortcutLabel = isMac ? '⌘N' : 'Ctrl+N'

// Why: the Agents tab badge counts agents that need human attention — blocked
// (explicit) and waiting (input requested). "working" agents are not counted:
// the goal is a VS-Code-style "problems" badge that appears only when there's
// something actionable, so a zero state reads as "nothing to look at". Kept in
// lockstep with useDashboardFilter's 'blocked' bucket so the number the user
// sees on the toggle matches the row count they find after switching.
function countAgentsNeedingAttention(
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
): number {
  let count = 0
  for (const entry of Object.values(agentStatusByPaneKey)) {
    if (entry.state === 'blocked' || entry.state === 'waiting') {
      count++
    }
  }
  return count
}

const SidebarHeader = React.memo(function SidebarHeader() {
  const openModal = useAppStore((s) => s.openModal)
  const repos = useAppStore((s) => s.repos)
  const canCreateWorktree = repos.some((repo) => isGitRepoKind(repo))

  const worktreeCardProperties = useAppStore((s) => s.worktreeCardProperties)
  const toggleWorktreeCardProperty = useAppStore((s) => s.toggleWorktreeCardProperty)
  const sortBy = useAppStore((s) => s.sortBy)
  const setSortBy = useAppStore((s) => s.setSortBy)
  const groupBy = useAppStore((s) => s.groupBy)
  const setGroupBy = useAppStore((s) => s.setGroupBy)

  const sidebarView = useAppStore((s) => s.sidebarView)
  const setSidebarView = useAppStore((s) => s.setSidebarView)
  // Why: gate the Agents tab behind the same experimental setting that gated
  // the old bottom-docked cockpit. Users who have not opted in keep the
  // pre-existing single-view sidebar — no new UI surfaces for them.
  // `showAgentDashboard` is the user-facing opt-out (Settings → Agents): it
  // previously hid the bottom-docked panel and now hides the Agents toggle
  // entirely, preserving the same "I don't want to see the cockpit" control.
  const dashboardExperimentEnabled = useAppStore(
    (s) => s.settings?.experimentalAgentDashboard === true
  )
  const showAgentDashboard = useAppStore((s) => s.settings?.showAgentDashboard !== false)
  const agentsToggleVisible = dashboardExperimentEnabled && showAgentDashboard
  // Why: select the raw map and derive the count with useMemo rather than
  // computing in the selector. Zustand re-invokes every selector on each
  // state change; a selector that returns a number recomputed from an object
  // would allocate in every unrelated update (tab switches, terminal events)
  // and force this memoized header to re-render needlessly. Memoizing on the
  // map reference matches how setAgentStatus preserves/mutates identity.
  const agentStatusByPaneKey = useAppStore((s) => s.agentStatusByPaneKey)
  const attentionCount = useMemo(
    () => countAgentsNeedingAttention(agentStatusByPaneKey),
    [agentStatusByPaneKey]
  )

  const viewingAgents = sidebarView === 'agents'
  // Why: keep the header icons in BOTH views so the sidebar chrome doesn't
  // shift when the user toggles between Workspaces and Agents — just repoint
  // the dropdown's contents at the active view's options. Preserving the same
  // slot positions (options, action button) avoids the jarring expand/collapse
  // of the toggle width that happens if the icons disappear on one side.
  const dashboardFilter = useAppStore((s) => s.dashboardFilter)
  const setDashboardFilter = useAppStore((s) => s.setDashboardFilter)

  return (
    <div className="flex h-8 items-center justify-between px-2 mt-1 gap-2">
      {agentsToggleVisible ? (
        <ToggleGroup
          type="single"
          value={sidebarView}
          onValueChange={(v) => {
            // Why: ToggleGroup reports '' when the user clicks the already-on
            // item. Treat that as a no-op so the sidebar never lands in a
            // neutral "neither view selected" state — one of workspaces/agents
            // must always be visible.
            if (v === 'workspaces' || v === 'agents') {
              setSidebarView(v)
            }
          }}
          variant="outline"
          size="sm"
          className="h-6 min-w-0 flex-1"
        >
          <ToggleGroupItem
            value="workspaces"
            className="h-6 flex-1 px-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/80 data-[state=on]:bg-foreground/10 data-[state=on]:text-foreground"
          >
            Workspaces
          </ToggleGroupItem>
          <ToggleGroupItem
            value="agents"
            className="h-6 flex-1 gap-1.5 px-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/80 data-[state=on]:bg-foreground/10 data-[state=on]:text-foreground"
          >
            <span>Agents</span>
            {attentionCount > 0 && (
              <span
                className={cn(
                  'inline-flex min-w-[14px] items-center justify-center rounded-full bg-amber-500/90 px-1 text-[9px] font-semibold leading-none text-white',
                  // Why: preserve badge color in both toggle states — amber
                  // conveys "needs attention" and should not dim out just
                  // because the user happens to be on the Workspaces side.
                  'h-[14px]'
                )}
                aria-label={`${attentionCount} agent${attentionCount === 1 ? '' : 's'} need attention`}
              >
                {attentionCount}
              </span>
            )}
          </ToggleGroupItem>
        </ToggleGroup>
      ) : (
        <span className="px-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80 select-none">
          Workspaces
        </span>
      )}
      <div className="flex items-center gap-1.5 shrink-0">
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground"
                  aria-label="View options"
                >
                  <SlidersHorizontal className="size-3.5" strokeWidth={2.25} />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              View options
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent side="right" align="start" sideOffset={8} className="w-56 pb-2">
            {viewingAgents ? (
              <>
                <DropdownMenuLabel>Show</DropdownMenuLabel>
                <div className="px-2 pt-0.5 pb-1">
                  <ToggleGroup
                    type="single"
                    value={dashboardFilter}
                    onValueChange={(v) => {
                      // Why: ToggleGroup fires '' on click-of-selected. Keep
                      // the previous filter rather than collapsing to a
                      // neutral state — the dashboard must always show some
                      // bucket, and 'all' is never worse than nothing.
                      if (
                        v === 'all' ||
                        v === 'active' ||
                        v === 'blocked' ||
                        v === 'done'
                      ) {
                        setDashboardFilter(v)
                      }
                    }}
                    variant="outline"
                    size="sm"
                    className="h-6 w-full justify-start"
                  >
                    {AGENT_FILTER_OPTIONS.map((opt) => (
                      <ToggleGroupItem
                        key={opt.id}
                        value={opt.id}
                        className="h-6 flex-1 px-2 text-[10px] data-[state=on]:bg-foreground/10 data-[state=on]:font-semibold data-[state=on]:text-foreground"
                      >
                        {opt.label}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </div>
              </>
            ) : (
              <>
                <DropdownMenuLabel>Group by</DropdownMenuLabel>
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
                    className="h-6 w-full justify-start"
                  >
                    {GROUP_BY_OPTIONS.map((opt) => (
                      <ToggleGroupItem
                        key={opt.id}
                        value={opt.id}
                        className="h-6 px-2 text-[10px] data-[state=on]:bg-foreground/10 data-[state=on]:font-semibold data-[state=on]:text-foreground"
                      >
                        {opt.label}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </div>

                <DropdownMenuSeparator />
                <DropdownMenuLabel>Sort by</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={sortBy}
                  onValueChange={(v) => setSortBy(v as typeof sortBy)}
                >
                  {SORT_OPTIONS.map((opt) => (
                    <DropdownMenuRadioItem
                      key={opt.id}
                      value={opt.id}
                      // Keep the menu open so people can compare sort modes and
                      // toggle card properties without reopening the same panel.
                      onSelect={(e) => e.preventDefault()}
                    >
                      {opt.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>

                <DropdownMenuSeparator />
                <DropdownMenuLabel>Show properties</DropdownMenuLabel>
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
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <Tooltip>
          <TooltipTrigger asChild>
            {/* Why: the "+" action is Workspaces-only (New workspace). For
                Agents view there is no meaningful "create" action — agents
                are spawned from terminals, not from this header — so render
                the button disabled + invisible to keep the icon slot reserved
                and the header chrome stable across view toggles. Using
                `visibility: hidden` rather than conditional render preserves
                layout width so the toggle doesn't expand to fill the gap. */}
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => {
                if (viewingAgents || !canCreateWorktree) {
                  return
                }
                openModal('new-workspace-composer')
              }}
              aria-label="New workspace"
              aria-hidden={viewingAgents}
              tabIndex={viewingAgents ? -1 : undefined}
              disabled={viewingAgents || !canCreateWorktree}
              className={cn(viewingAgents && 'invisible')}
            >
              <Plus className="size-3.5" strokeWidth={2.25} />
            </Button>
          </TooltipTrigger>
          {!viewingAgents && (
            <TooltipContent side="right" sideOffset={6}>
              {canCreateWorktree
                ? `New workspace (${newWorktreeShortcutLabel})`
                : 'Add a Git project to create worktrees'}
            </TooltipContent>
          )}
        </Tooltip>
      </div>
    </div>
  )
})

export default SidebarHeader
