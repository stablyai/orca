import type React from 'react'
import {
  DropdownMenuCheckboxItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { ALL_EXECUTION_HOSTS_SCOPE } from '../../../../shared/execution-host'
import type {
  VisibleWorkspaceHostIds,
  WorkspaceHostScope
} from '../../../../shared/ui-chrome-types'
import { pickerExecutionHosts } from '../../../../shared/managed-orcad-execution-host'
import {
  getCheckedHostRows,
  toggleAllVisibleHosts,
  toggleVisibleHostRow
} from '../../../../shared/workspace-view/workspace-host-visibility'
import { getSidebarHostHealthLabel, type SidebarHostOption } from './sidebar-host-options'
import { useBoundedHostRows } from '../host-picker/use-bounded-host-rows'
import { HostListSearchField } from '../host-picker/HostListSearchField'
import { HostListOverflowNote } from '../host-picker/HostListOverflowNote'
import { translate } from '@/i18n/i18n'

type SidebarHostScopeMenuSectionProps = {
  hostVisibilityLabel: string
  hostOptions: readonly SidebarHostOption[]
  preserveWorkspaceBoardOpen: boolean
  setWorkspaceHostScope: (scope: WorkspaceHostScope) => void
  visibleWorkspaceHostIds: VisibleWorkspaceHostIds
  setVisibleWorkspaceHostIds: (ids: VisibleWorkspaceHostIds) => void
}

function getHostMetadata(host: SidebarHostOption): string {
  const healthLabel = getSidebarHostHealthLabel(host.health, host.blockedReason)
  if (host.kind === 'local') {
    return host.detail
  }
  if (host.kind === 'ssh') {
    const presenceLabel =
      host.presence === 'configured'
        ? translate(
            'auto.components.sidebar.SidebarWorkspaceOptionsMenu.configuredSshHost',
            'Configured SSH'
          )
        : translate(
            'auto.components.sidebar.SidebarWorkspaceOptionsMenu.projectSshHost',
            'Project SSH'
          )
    return `${presenceLabel} · ${healthLabel}`
  }
  const presenceLabel =
    host.presence === 'active'
      ? translate(
          'auto.components.sidebar.SidebarWorkspaceOptionsMenu.activeRuntimeHost',
          'Default for new projects'
        )
      : translate(
          'auto.components.sidebar.SidebarWorkspaceOptionsMenu.projectRuntimeHost',
          'Project server'
        )
  return `${presenceLabel} · ${healthLabel}`
}

export function SidebarHostScopeMenuSection({
  hostVisibilityLabel,
  hostOptions,
  preserveWorkspaceBoardOpen,
  setWorkspaceHostScope,
  visibleWorkspaceHostIds,
  setVisibleWorkspaceHostIds
}: SidebarHostScopeMenuSectionProps): React.JSX.Element {
  const allVisible = !visibleWorkspaceHostIds
  const hostRows = pickerExecutionHosts(hostOptions)
  const checkedRowIds = new Set(
    (visibleWorkspaceHostIds
      ? getCheckedHostRows(hostRows, visibleWorkspaceHostIds)
      : hostRows
    ).map((host) => host.id)
  )

  // Pin checked filter matches so users can still uncheck them.
  const rows = useBoundedHostRows(hostRows, allVisible ? undefined : checkedRowIds)

  const toggleAllHosts = (): void => {
    const next = toggleAllVisibleHosts(hostOptions, visibleWorkspaceHostIds)
    if (next === null) {
      setWorkspaceHostScope(ALL_EXECUTION_HOSTS_SCOPE)
    } else if (next) {
      setVisibleWorkspaceHostIds(next)
    }
  }

  const toggleHost = (host: SidebarHostOption): void => {
    const next = toggleVisibleHostRow(hostOptions, visibleWorkspaceHostIds, host)
    if (next !== undefined) {
      setVisibleWorkspaceHostIds(next)
    }
  }

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <span className="flex flex-1 items-center justify-between gap-3">
          <span>
            {translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.hosts', 'Hosts')}
          </span>
          <span className="min-w-0 truncate text-[11px] font-medium text-muted-foreground">
            {hostVisibilityLabel}
          </span>
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        className="w-56"
        data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
      >
        <DropdownMenuCheckboxItem
          checked={allVisible}
          onCheckedChange={toggleAllHosts}
          onSelect={(e) => e.preventDefault()}
          className="min-h-11 items-start py-1.5"
        >
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate">
              {translate('auto.components.sidebar.sidebarHostOptions.3e102f111c', 'All hosts')}
            </span>
            <span className="truncate text-[11px] font-normal text-muted-foreground">
              {translate(
                'auto.components.sidebar.SidebarWorkspaceOptionsMenu.allHostsDetail',
                'Show every host'
              )}
            </span>
          </span>
        </DropdownMenuCheckboxItem>
        {rows.searchable ? (
          <HostListSearchField value={rows.query} onChange={rows.setQuery} inMenu />
        ) : null}
        {/* Bound up to 50 host rows plus pinned matches so the menu stays on screen. */}
        <div className="max-h-80 overflow-y-auto scrollbar-sleek">
          {rows.shown.map((host) => (
            <DropdownMenuCheckboxItem
              key={host.id}
              checked={!allVisible && checkedRowIds.has(host.id)}
              disabled={!allVisible && checkedRowIds.has(host.id) && checkedRowIds.size <= 1}
              onCheckedChange={() => toggleHost(host)}
              onSelect={(e) => e.preventDefault()}
              className="min-h-11 items-start py-1.5"
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate">{host.label}</span>
                <span className="text-[11px] font-normal text-muted-foreground">
                  {getHostMetadata(host)}
                </span>
              </span>
            </DropdownMenuCheckboxItem>
          ))}
        </div>
        <HostListOverflowNote hiddenCount={rows.hiddenCount} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
