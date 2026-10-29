import { shallow } from 'zustand/shallow'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import type { WorkspaceHostScope } from '../../../../shared/ui-chrome-types'
import {
  ALL_EXECUTION_HOSTS_SCOPE,
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import {
  buildExecutionHostRegistry,
  type ExecutionHostHealth,
  type ExecutionHostRegistryEntry
} from '../../../../shared/execution-host-registry'

import { getExecutionHostHealthLabel } from '@/lib/runtime-host-copy'
import { pickerExecutionHosts } from '../../../../shared/managed-orcad-execution-host'
import { getCheckedHostRows } from '../../../../shared/workspace-view/workspace-host-visibility'
import type { RuntimeCompatVerdict } from '../../../../shared/protocol-compat'
import type { SshConnectionState, SshConnectionStatus } from '../../../../shared/ssh-types'
import {
  isWslHostRuntimeEnvironment,
  type PublicKnownRuntimeEnvironment
} from '../../../../shared/runtime-environments'
import type {
  RuntimeEnvironmentStatus,
  RuntimeHostBlockedReason
} from '../../../../shared/runtime-host-status'
import type { WslHostStatus } from '../../../../shared/wsl-host-types'
import { translate } from '@/i18n/i18n'
import { sshConnectFailureText } from '@/ssh/ssh-host-server-status-copy'
import {
  getWslHostRowDetail,
  getWslHostRowHealth,
  getWslHostRowServerFilesMissingDetail,
  getWslHostRowTurnedOffDetail
} from './wsl-host-row-status'

export type SidebarHostOption = {
  id: ExecutionHostId
  label: string
  detail: string
  kind: 'local' | 'ssh' | 'runtime'
  health: ExecutionHostHealth
  presence: 'local' | 'configured' | 'project' | 'active'
  /** Why a failed SSH host failed, as Settings → SSH Hosts says it; host pickers show it. */
  failureReason?: string
  // Host menus need the compatibility verdict to explain version skew.
  compatibility?: RuntimeCompatVerdict
  blockedReason?: RuntimeHostBlockedReason
  // Host headers use this status to describe authentication requirements.
  connectionStatus?: SshConnectionStatus
  aliasHostIds?: readonly ExecutionHostId[]
  mergedIntoHostId?: ExecutionHostId
  /** Set on a WSL host's row: the distro its Orca server runs in. */
  wslDistro?: string
  /** Why a listed WSL host cannot run: the experiment is off, or this build lacks its server files. */
  wslUnavailable?: 'turned-off' | 'server-files-missing'
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
  // Reuse live server status for compatibility and health without re-probing.
  runtimeStatusByEnvironmentId?: ReadonlyMap<string, RuntimeEnvironmentStatus>
  runtimeEnvironments?: readonly Pick<
    PublicKnownRuntimeEnvironment,
    'id' | 'name' | 'source' | 'orcadDeployment'
  >[]
  // Apply display-label overrides consistently across sidebar host controls.
  hostLabelOverrides?: ReadonlyMap<ExecutionHostId, string>
  wslHostStatuses?: Readonly<Record<string, WslHostStatus>>
  /** False keeps WSL hosts' rows but marks them turned off. */
  wslHostsEnabled?: boolean
  /** True keeps WSL hosts' rows but marks them unable to run in this build. */
  wslHostServerFilesMissing?: boolean
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
  const wslDistroByHostId = new Map<ExecutionHostId, { environmentId: string; distro: string }>()
  for (const environment of args.runtimeEnvironments ?? []) {
    if (isWslHostRuntimeEnvironment(environment)) {
      wslDistroByHostId.set(toRuntimeExecutionHostId(environment.id), {
        environmentId: environment.id,
        distro: environment.orcadDeployment.distro
      })
    }
  }
  const activeRuntimeHostId = args.settings?.activeRuntimeEnvironmentId?.trim()
    ? toRuntimeExecutionHostId(args.settings.activeRuntimeEnvironmentId.trim())
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
      const state = args.sshConnectionStates?.get(targetId)
      // Disconnected hosts remain listed when configured or still referenced by projects.
      return {
        ...host,
        ...(host.health === 'error' && state
          ? { failureReason: sshConnectFailureText(state, state.error?.trim() || host.detail) }
          : {}),
        presence: configuredSshTargetIds.has(targetId)
          ? 'configured'
          : projectSshTargetIds.has(targetId)
            ? 'project'
            : 'active'
      }
    }
    const wsl = wslDistroByHostId.get(host.id)
    const status = wsl ? args.wslHostStatuses?.[wsl.environmentId] : undefined
    return {
      ...host,
      ...(wsl && args.wslHostServerFilesMissing === true
        ? {
            wslDistro: wsl.distro,
            wslUnavailable: 'server-files-missing' as const,
            detail: getWslHostRowServerFilesMissingDetail(),
            health: 'disconnected' as const
          }
        : wsl && args.wslHostsEnabled === false
          ? {
              wslDistro: wsl.distro,
              wslUnavailable: 'turned-off' as const,
              detail: getWslHostRowTurnedOffDetail(),
              health: 'disconnected' as const
            }
          : wsl
            ? {
                wslDistro: wsl.distro,
                detail: getWslHostRowDetail(status),
                health: getWslHostRowHealth(host.health, status)
              }
            : {}),
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
    return translate('auto.components.sidebar.sidebarHostOptions.hosts', 'Hosts')
  }
  return translate(
    'auto.components.sidebar.sidebarHostOptions.visibleHosts_other',
    '{{count}} hosts',
    {
      count: checkedRows.length
    }
  )
}

export function getSidebarHostHealthLabel(
  health: SidebarHostScopeOption['health'],
  blockedReason?: RuntimeHostBlockedReason
): string {
  return health === 'mixed'
    ? translate('runtime.health.mixed', 'Mixed')
    : getExecutionHostHealthLabel(health, blockedReason)
}

// Diagnostics do not change host choices; retain every other exposed registry field.
export function sidebarHostSemantics(host: SidebarHostOption & ExecutionHostRegistryEntry) {
  const { remoteControlState, ...option } = host
  return {
    ...option,
    remoteControlState: remoteControlState && {
      state: remoteControlState.state,
      lastError: remoteControlState.lastError,
      lastClose: remoteControlState.lastClose,
      lastCloseCause: remoteControlState.lastCloseCause
    }
  }
}

export function createSidebarHostLabelsSelector() {
  let result = new Map<ExecutionHostId, string>()
  return (hosts: readonly SidebarHostOption[]): ReadonlyMap<ExecutionHostId, string> => {
    const next = new Map(hosts.map((host) => [host.id, host.label]))
    if (!shallow(result, next)) {
      result = next
    }
    return result
  }
}
