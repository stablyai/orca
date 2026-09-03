import React, { useMemo } from 'react'
import { X } from 'lucide-react'
import { useAppStore } from '@/store'
import { DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import SidebarRepositoryFilterSection from '@/components/sidebar/SidebarRepositoryFilterSection'
import { SidebarHostScopeMenuSection } from '@/components/sidebar/SidebarHostScopeMenuSection'
import {
  getSidebarHostVisibilityLabel,
  shouldShowHostScopeControls
} from '@/components/sidebar/sidebar-host-options'
import { useSidebarHostScopeOptions } from '@/components/sidebar/use-sidebar-host-scope-options'
import type { SidebarHostOption } from '@/components/sidebar/sidebar-host-options'
import { getExecutionHostLabel, type ExecutionHostId } from '../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'

/**
 * Host/project scope controls for the Agents activity surfaces. State is the
 * persisted agents-view scope (agentsVisibleHostIds / agentsFilterRepoIds),
 * deliberately separate from the workspace-nav filters.
 */
export function ActivityScopeFilterMenuSections(): React.JSX.Element | null {
  const repos = useAppStore((s) => s.repos)
  const agentsVisibleHostIds = useAppStore((s) => s.agentsVisibleHostIds)
  const setAgentsVisibleHostIds = useAppStore((s) => s.setAgentsVisibleHostIds)
  const agentsFilterRepoIds = useAppStore((s) => s.agentsFilterRepoIds)
  const setAgentsFilterRepoIds = useAppStore((s) => s.setAgentsFilterRepoIds)
  const { hostOptions } = useSidebarHostScopeOptions()
  const showHostScopeControls = shouldShowHostScopeControls(hostOptions)

  if (!showHostScopeControls && repos.length <= 1) {
    return null
  }
  return (
    <>
      {showHostScopeControls ? (
        <SidebarHostScopeMenuSection
          hostVisibilityLabel={getSidebarHostVisibilityLabel(agentsVisibleHostIds, hostOptions)}
          hostOptions={hostOptions}
          preserveWorkspaceBoardOpen={false}
          // Why: the section only calls this to reset to "all hosts".
          setWorkspaceHostScope={() => setAgentsVisibleHostIds(null)}
          visibleWorkspaceHostIds={agentsVisibleHostIds}
          setVisibleWorkspaceHostIds={setAgentsVisibleHostIds}
        />
      ) : null}
      <SidebarRepositoryFilterSection
        filterRepoIds={agentsFilterRepoIds}
        setFilterRepoIds={setAgentsFilterRepoIds}
      />
      <DropdownMenuSeparator />
    </>
  )
}

// Why not getSidebarHostVisibilityLabel: it collapses a full selection to "All
// hosts", but a chip only renders while a filter is set — name the selection,
// falling back to the raw host label for hosts no longer in the options list.
function getScopeHostChipLabel(
  visibleHostIds: readonly ExecutionHostId[],
  hostOptions: readonly SidebarHostOption[]
): string {
  if (visibleHostIds.length === 1) {
    const id = visibleHostIds[0]
    return hostOptions.find((host) => host.id === id)?.label ?? getExecutionHostLabel(id)
  }
  return translate(
    'auto.components.sidebar.sidebarHostOptions.visibleHostsCount',
    '{{value0}} hosts',
    { value0: visibleHostIds.length }
  )
}

function ScopeFilterChip({
  label,
  clearLabel,
  onClear
}: {
  label: string
  clearLabel: string
  onClear: () => void
}): React.JSX.Element {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 rounded-full border border-border/80 bg-muted/80 py-0.5 pl-2 pr-1 text-[11px] font-medium leading-none text-foreground/80 shadow-xs">
      <span className="min-w-0 truncate">{label}</span>
      <button
        type="button"
        aria-label={clearLabel}
        onClick={onClear}
        className="rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <X className="size-2.5" />
      </button>
    </span>
  )
}

/**
 * Dismissible chips naming the active persisted scope.
 * Why always shown while a scope is active: the filter survives restarts, so an
 * invisible one would silently hide running agents from a monitoring surface.
 *
 * Why the outer/inner split: this stays mounted on every activity surface, so
 * while no scope is set it must subscribe only to the two filter fields — the
 * host-registry derivation (settings, SSH/runtime status churn) lives in the
 * inner row and mounts only for an active filter.
 */
export function ActivityScopeFilterChips(): React.JSX.Element | null {
  const agentsVisibleHostIds = useAppStore((s) => s.agentsVisibleHostIds)
  const agentsFilterRepoIds = useAppStore((s) => s.agentsFilterRepoIds)
  if (agentsVisibleHostIds === null && agentsFilterRepoIds.length === 0) {
    return null
  }
  return <ActiveScopeFilterChipsRow />
}

function ActiveScopeFilterChipsRow(): React.JSX.Element | null {
  const repos = useAppStore((s) => s.repos)
  const agentsVisibleHostIds = useAppStore((s) => s.agentsVisibleHostIds)
  const setAgentsVisibleHostIds = useAppStore((s) => s.setAgentsVisibleHostIds)
  const agentsFilterRepoIds = useAppStore((s) => s.agentsFilterRepoIds)
  const setAgentsFilterRepoIds = useAppStore((s) => s.setAgentsFilterRepoIds)
  const { hostOptions } = useSidebarHostScopeOptions()

  const selectedRepoNames = useMemo(
    () =>
      repos.filter((repo) => agentsFilterRepoIds.includes(repo.id)).map((repo) => repo.displayName),
    [repos, agentsFilterRepoIds]
  )
  const hasHostFilter = agentsVisibleHostIds !== null
  const hasRepoFilter = selectedRepoNames.length > 0
  // Why: a repo filter of only-stale ids renders nothing; the outer gate is a fast path, not the authority.
  if (!hasHostFilter && !hasRepoFilter) {
    return null
  }
  const repoLabel =
    selectedRepoNames.length === 1
      ? selectedRepoNames[0]
      : translate(
          'auto.components.sidebar.SidebarRepositoryFilterSection.selectedProjectsCount',
          '{{value0}} projects',
          { value0: selectedRepoNames.length }
        )
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
      {agentsVisibleHostIds ? (
        <ScopeFilterChip
          label={getScopeHostChipLabel(agentsVisibleHostIds, hostOptions)}
          clearLabel={translate(
            'auto.components.activity.ActivityScopeFilterControls.clearHostFilter',
            'Show all hosts'
          )}
          onClear={() => setAgentsVisibleHostIds(null)}
        />
      ) : null}
      {hasRepoFilter ? (
        <ScopeFilterChip
          label={repoLabel}
          clearLabel={translate(
            'auto.components.activity.ActivityScopeFilterControls.clearProjectFilter',
            'Show all projects'
          )}
          onClear={() => setAgentsFilterRepoIds([])}
        />
      ) : null}
    </div>
  )
}
