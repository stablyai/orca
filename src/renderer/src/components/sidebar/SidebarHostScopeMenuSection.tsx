import type React from 'react'
import {
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { ALL_EXECUTION_HOSTS_SCOPE, type ExecutionHostId } from '../../../../shared/execution-host'
import type { VisibleWorkspaceHostIds, WorkspaceHostScope } from '../../../../shared/types'
import { getSidebarHostHealthLabel, type SidebarHostOption } from './sidebar-host-options'
import { translate } from '@/i18n/i18n'

type SidebarHostScopeMenuSectionProps = {
  hostOptionsCount: number
  hostVisibilityLabel: string
  hostOptions: readonly SidebarHostOption[]
  preserveWorkspaceBoardOpen: boolean
  setWorkspaceHostScope: (scope: WorkspaceHostScope) => void
  visibleWorkspaceHostIds: VisibleWorkspaceHostIds
  setVisibleWorkspaceHostIds: (ids: VisibleWorkspaceHostIds) => void
}

function getHostMetadata(host: SidebarHostOption): string {
  const healthLabel = getSidebarHostHealthLabel(host.health)
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
          'Active server'
        )
      : translate(
          'auto.components.sidebar.SidebarWorkspaceOptionsMenu.projectRuntimeHost',
          'Project server'
        )
  return `${presenceLabel} · ${healthLabel}`
}

export function SidebarHostScopeMenuSection({
  hostOptionsCount,
  hostVisibilityLabel,
  hostOptions,
  preserveWorkspaceBoardOpen,
  setWorkspaceHostScope,
  visibleWorkspaceHostIds,
  setVisibleWorkspaceHostIds
}: SidebarHostScopeMenuSectionProps): React.JSX.Element {
  const allVisible = !visibleWorkspaceHostIds
  const visibleHostIdSet = new Set(visibleWorkspaceHostIds ?? [])

  const toggleAllHosts = (): void => {
    if (!allVisible) {
      setWorkspaceHostScope(ALL_EXECUTION_HOSTS_SCOPE)
      return
    }
    const firstHost = hostOptions[0]
    if (firstHost) {
      setVisibleWorkspaceHostIds([firstHost.id])
    }
  }

  const toggleHost = (hostId: ExecutionHostId): void => {
    if (allVisible) {
      setVisibleWorkspaceHostIds([hostId])
      return
    }
    const next = new Set(visibleHostIdSet)
    if (next.has(hostId)) {
      if (next.size <= 1) {
        return
      }
      next.delete(hostId)
    } else {
      next.add(hostId)
    }
    setVisibleWorkspaceHostIds(next.size === hostOptions.length ? null : [...next])
  }

  return (
    <>
      <DropdownMenuLabel>
        {translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.hosts', 'Hosts')}
      </DropdownMenuLabel>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <span className="flex flex-1 items-center justify-between gap-3">
            <span className="min-w-0 truncate">{hostVisibilityLabel}</span>
            <span className="text-[11px] font-medium text-muted-foreground">
              {hostOptionsCount}
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
          {hostOptions.map((host) => (
            <DropdownMenuCheckboxItem
              key={host.id}
              checked={visibleHostIdSet.has(host.id)}
              disabled={!allVisible && visibleHostIdSet.has(host.id) && visibleHostIdSet.size <= 1}
              onCheckedChange={() => toggleHost(host.id)}
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
        </DropdownMenuSubContent>
      </DropdownMenuSub>

      <DropdownMenuSeparator />
    </>
  )
}
