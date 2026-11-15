import React, { useMemo } from 'react'
import {
  DropdownMenuCheckboxItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { ALL_EXECUTION_HOSTS_SCOPE } from '../../../../../../shared/execution-host'
import type {
  VisibleWorkspaceHostIds,
  WorkspaceHostScope
} from '../../../../../../shared/ui-chrome-types'
import { pickerExecutionHosts } from '../../../../../../shared/execution-host/managed-orcad-execution-host'
import {
  getCheckedHostRows,
  toggleAllVisibleHosts,
  toggleVisibleHostRow,
  workspaceHostScopeForVisibleHosts
} from '../../../../../../shared/workspace-view/workspace-host-visibility'
import { getSidebarHostHealthLabel, type SidebarHostOption } from './sidebar-host-options'
import { useBoundedHostRows } from '../../../host-picker/use-bounded-host-rows'
import { HostListSearchField } from '../../../host-picker/HostListSearchField'
import { HostListOverflowNote } from '../../../host-picker/HostListOverflowNote'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { translateExecutionHostDetail, translateHostDisplayLabel } from '../../execution-host-label'

type SidebarHostScopeMenuSectionProps = {
  hostVisibilityLabel: string
  hostOptions: readonly SidebarHostOption[]
  preserveWorkspaceBoardOpen: boolean
  setWorkspaceHostScope: (scope: WorkspaceHostScope) => void
  visibleWorkspaceHostIds: VisibleWorkspaceHostIds
  setVisibleWorkspaceHostIds: (ids: VisibleWorkspaceHostIds, scope?: WorkspaceHostScope) => void
}

function getHostMetadata(host: SidebarHostOption, t: Translate = translate): string {
  const healthLabel = getSidebarHostHealthLabel(host.health, host.blockedReason, t, host.vmState)
  if (host.kind === 'local') {
    return translateExecutionHostDetail(host.detail)
  }
  if (host.kind === 'ssh') {
    const presenceLabel =
      host.presence === 'configured'
        ? t(
            'auto.components.sidebar.SidebarWorkspaceOptionsMenu.configuredSshHost',
            'Configured SSH'
          )
        : t('auto.components.sidebar.SidebarWorkspaceOptionsMenu.projectSshHost', 'Project SSH')
    return `${presenceLabel} · ${healthLabel}`
  }
  const presenceLabel =
    host.presence === 'active'
      ? t(
          'auto.components.sidebar.SidebarWorkspaceOptionsMenu.activeRuntimeHost',
          'Default for new projects'
        )
      : t(
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
  const t = useTranslate()
  const allVisible = !visibleWorkspaceHostIds
  const hostRows = useMemo(
    () =>
      pickerExecutionHosts(hostOptions).map((host) => ({
        ...host,
        searchText: translateHostDisplayLabel(host, t)
      })),
    [hostOptions, t]
  )
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
      // Row-aware scope: one merged row saves several equivalent IDs and must keep its scope (#41140).
      setVisibleWorkspaceHostIds(next, workspaceHostScopeForVisibleHosts(next, hostOptions))
    }
  }

  const toggleHost = (host: SidebarHostOption): void => {
    const next = toggleVisibleHostRow(hostOptions, visibleWorkspaceHostIds, host)
    if (next !== undefined) {
      setVisibleWorkspaceHostIds(next, workspaceHostScopeForVisibleHosts(next, hostOptions))
    }
  }

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <span className="flex flex-1 items-center justify-between gap-3">
          <span>{t('auto.components.sidebar.SidebarWorkspaceOptionsMenu.hosts', 'Hosts')}</span>
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
              {t('auto.components.sidebar.sidebarHostOptions.3e102f111c', 'All hosts')}
            </span>
            <span className="truncate text-[11px] font-normal text-muted-foreground">
              {t(
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
                <span className="truncate">{translateHostDisplayLabel(host, t)}</span>
                <span className="text-[11px] font-normal text-muted-foreground">
                  {getHostMetadata(host, t)}
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
