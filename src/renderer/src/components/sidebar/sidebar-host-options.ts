import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import type { WorkspaceHostScope } from '../../../../shared/ui-chrome-types'
import {
  ALL_EXECUTION_HOSTS_SCOPE,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import {
  buildExecutionHostRegistry,
  type ExecutionHostHealth
} from '../../../../shared/execution-host-registry'
import {
  expandEquivalentExecutionHostIds,
  pickerExecutionHosts
} from '../../../../shared/managed-orcad-execution-host'
import type { RuntimeCompatVerdict } from '../../../../shared/protocol-compat'
import type { SshConnectionState, SshConnectionStatus } from '../../../../shared/ssh-types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { RuntimeEnvironmentStatus } from '../../../../shared/runtime-host-status'
import { translate } from '@/i18n/i18n'

export type SidebarHostOption = {
  id: ExecutionHostId
  label: string
  detail: string
  kind: 'local' | 'ssh' | 'runtime'
  health: ExecutionHostHealth
  presence: 'local' | 'configured' | 'project' | 'active'
  // Why: surfaced to the sidebar host-header menu so it can warn on version skew.
  compatibility?: RuntimeCompatVerdict
  // Why: lets host headers spell out auth-needed SSH states, not just an icon.
  connectionStatus?: SshConnectionStatus
  aliasHostIds?: readonly ExecutionHostId[]
  mergedIntoHostId?: ExecutionHostId
}

export type SidebarHostScopeOption = {
  id: WorkspaceHostScope
  label: string
  detail: string
  health: ExecutionHostHealth | 'mixed'
}

export function buildSidebarHostOptions(args: {
  repos: readonly Pick<Repo, 'connectionId' | 'executionHostId'>[]
  sshTargetLabels: ReadonlyMap<string, string>
  sshConnectionStates?: ReadonlyMap<string, SshConnectionState>
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
  // Why: live per-environment runtime status lets the registry surface compat
  // verdicts and blocked health in the sidebar without re-probing servers.
  runtimeStatusByEnvironmentId?: ReadonlyMap<string, RuntimeEnvironmentStatus>
  runtimeEnvironments?: readonly Pick<
    PublicKnownRuntimeEnvironment,
    'id' | 'name' | 'source' | 'orcadDeployment'
  >[]
  // Why: per-host display-label overrides rename hosts everywhere the sidebar
  // options feed (host headers, scope picker, focus menu).
  hostLabelOverrides?: ReadonlyMap<ExecutionHostId, string>
}): SidebarHostOption[] {
  const configuredSshTargetIds = new Set(args.sshTargetLabels.keys())
  const projectSshTargetIds = new Set<string>()
  for (const repo of args.repos) {
    if (repo.connectionId?.trim()) {
      projectSshTargetIds.add(repo.connectionId.trim())
    }
    if (repo.executionHostId?.startsWith('ssh:')) {
      projectSshTargetIds.add(decodeURIComponent(repo.executionHostId.slice('ssh:'.length)))
    }
  }
  const activeRuntimeHostId = args.settings?.activeRuntimeEnvironmentId?.trim()
    ? (`runtime:${encodeURIComponent(args.settings.activeRuntimeEnvironmentId.trim())}` as const)
    : null
  return buildExecutionHostRegistry({
    repos: args.repos,
    settings: args.settings,
    sshTargetLabels: args.sshTargetLabels,
    sshConnectionStates: args.sshConnectionStates,
    runtimeEnvironments: args.runtimeEnvironments,
    runtimeStatusByEnvironmentId: args.runtimeStatusByEnvironmentId,
    hostLabelOverrides: args.hostLabelOverrides
  }).map((host) => {
    if (host.kind === 'local') {
      return { ...host, presence: 'local' }
    }
    if (host.kind === 'ssh') {
      const targetId = decodeURIComponent(host.id.slice('ssh:'.length))
      // Why: configured hosts explain why a disconnected target remains
      // visible; project-only hosts remain because workspaces still point at it.
      return {
        ...host,
        presence: configuredSshTargetIds.has(targetId)
          ? 'configured'
          : projectSshTargetIds.has(targetId)
            ? 'project'
            : 'active'
      }
    }
    return {
      ...host,
      presence: host.id === activeRuntimeHostId ? 'active' : 'project'
    }
  })
}

export function shouldShowHostScopeControls(hosts: readonly SidebarHostOption[]): boolean {
  return pickerExecutionHosts(hosts).some((host) => host.id !== LOCAL_EXECUTION_HOST_ID)
}

export function buildSidebarHostScopeOptions(
  allHosts: readonly SidebarHostOption[]
): SidebarHostScopeOption[] {
  const hosts = pickerExecutionHosts(allHosts)
  return [
    {
      id: ALL_EXECUTION_HOSTS_SCOPE,
      label: translate('auto.components.sidebar.sidebarHostOptions.3e102f111c', 'All hosts'),
      detail: hosts.map((host) => host.label).join(', '),
      health: 'mixed'
    },
    ...hosts.map((host) => ({
      id: host.id,
      label: host.label,
      detail: host.detail,
      health: host.health
    }))
  ]
}

export function getSidebarHostVisibilityLabel(
  visibleHostIds: readonly ExecutionHostId[] | null | undefined,
  hosts: readonly SidebarHostOption[]
): string {
  const rows = pickerExecutionHosts(hosts)
  const checkedRows = visibleHostIds ? getCheckedHostRows(rows, visibleHostIds) : rows
  if (checkedRows.length === rows.length) {
    return translate('auto.components.sidebar.sidebarHostOptions.3e102f111c', 'All hosts')
  }
  if (checkedRows.length === 1) {
    return checkedRows[0].label
  }
  if (checkedRows.length === 0) {
    return 'Hosts'
  }
  return translate(
    'auto.components.sidebar.sidebarHostOptions.visibleHostsCount',
    '{{value0}} hosts',
    { value0: checkedRows.length }
  )
}

/** Picker rows a saved visibility list selects; a row counts when any id it stands for is saved. */
export function getCheckedHostRows<T extends SidebarHostOption>(
  rows: readonly T[],
  visibleHostIds: readonly ExecutionHostId[]
): T[] {
  const visible = new Set(visibleHostIds)
  return rows.filter(
    (row) => visible.has(row.id) || (row.aliasHostIds ?? []).some((id) => visible.has(id))
  )
}

export function getSidebarHostHealthLabel(health: SidebarHostScopeOption['health']): string {
  switch (health) {
    case 'local':
      return 'Local'
    case 'available':
      return 'Connected'
    case 'connecting':
      return 'Connecting'
    case 'blocked':
      return 'Update needed'
    case 'disconnected':
      return 'Disconnected'
    case 'error':
      return 'Needs attention'
    case 'mixed':
      return 'Mixed'
  }
}

/**
 * The visibility list after toggling one picker row, or undefined when the toggle is refused (the
 * last checked row). A row writes every id it stands for, so exact-id filters match both owners.
 */
export function toggleVisibleHostRow(
  hosts: readonly SidebarHostOption[],
  visibleHostIds: readonly ExecutionHostId[] | null,
  row: SidebarHostOption
): ExecutionHostId[] | null | undefined {
  const rowIds = expandEquivalentExecutionHostIds(hosts, [row.id])
  if (!visibleHostIds) {
    return rowIds
  }
  const rows = pickerExecutionHosts(hosts)
  const checkedRows = getCheckedHostRows(rows, visibleHostIds)
  const next = new Set(visibleHostIds)
  if (checkedRows.some((checked) => checked.id === row.id)) {
    if (checkedRows.length <= 1) {
      return undefined
    }
    rowIds.forEach((id) => next.delete(id))
  } else {
    rowIds.forEach((id) => next.add(id))
  }
  return getCheckedHostRows(rows, [...next]).length === rows.length ? null : [...next]
}
