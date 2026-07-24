import {
  getExecutionHostLabel,
  isRuntimeOwnedSshTargetId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { ExecutionHostRegistryEntry } from '../../../shared/execution-host-registry'
import { isEphemeralVmRuntimeEnvironment } from '../../../shared/runtime-environments'
import {
  PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
  WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import type { ProjectHostSetup, Repo } from '../../../shared/types'

export type ProjectHostSetupOption =
  | {
      id: string
      kind: 'ready'
      projectId: string
      hostId: ExecutionHostId
      repoId: string
      label: string
      detail: string
      path: string
    }
  | {
      id: string
      kind: 'needs-setup'
      projectId: string
      hostId: ExecutionHostId
      label: string
      detail: string
      isAvailable: boolean
      // Why: only a genuine connection error warrants an alarm glyph; a dormant
      // disconnected host is merely not-yet-connected, not broken.
      attention: boolean
      connectAction?: { kind: 'ssh'; targetId: string } | { kind: 'runtime'; environmentId: string }
    }

export type ReadyProjectHostSetupOption = Extract<ProjectHostSetupOption, { kind: 'ready' }>

export type NeedsSetupProjectHostOption = Extract<ProjectHostSetupOption, { kind: 'needs-setup' }>

type BuildReadySetupOptionsInput = {
  projectId: string
  projectHostSetups: readonly ProjectHostSetup[]
  eligibleRepos: readonly Repo[]
  hosts: readonly ExecutionHostRegistryEntry[]
}

type BuildNeedsSetupOptionsInput = {
  projectId: string
  hosts: readonly ExecutionHostRegistryEntry[]
  readySetupByHost: ReadonlyMap<ExecutionHostId, ReadyProjectHostSetupOption>
  pendingSetupByHost: ReadonlyMap<ExecutionHostId, ProjectHostSetup>
}

type BuildProjectHostSetupOptionsInput = {
  projectId: string | null
  projectHostSetups: readonly ProjectHostSetup[]
  eligibleRepos: readonly Repo[]
  hosts?: readonly ExecutionHostRegistryEntry[]
}

export function buildProjectHostSetupOptions({
  projectId,
  projectHostSetups,
  eligibleRepos,
  hosts = []
}: BuildProjectHostSetupOptionsInput): ProjectHostSetupOption[] {
  if (!projectId) {
    return []
  }
  const readyOptions = buildReadySetupOptions({
    projectId,
    projectHostSetups,
    eligibleRepos,
    hosts
  })
  const readySetupByHost = new Map(readyOptions.map((option) => [option.hostId, option]))
  const pendingSetupByHost = getPendingSetupByHost(projectId, projectHostSetups)
  return [
    ...readyOptions,
    ...buildNeedsSetupOptions({
      projectId,
      hosts,
      readySetupByHost,
      pendingSetupByHost
    })
  ].sort((a, b) => compareProjectHostSetupOptions(a, b))
}

function getPendingSetupByHost(
  projectId: string,
  projectHostSetups: readonly ProjectHostSetup[]
): Map<ExecutionHostId, ProjectHostSetup> {
  const setups = new Map<ExecutionHostId, ProjectHostSetup>()
  for (const setup of projectHostSetups) {
    if (setup.projectId !== projectId || setup.setupState === 'ready') {
      continue
    }
    if (!setups.has(setup.hostId)) {
      setups.set(setup.hostId, setup)
    }
  }
  return setups
}

function buildReadySetupOptions({
  projectId,
  projectHostSetups,
  eligibleRepos,
  hosts
}: BuildReadySetupOptionsInput): ReadyProjectHostSetupOption[] {
  const eligibleRepoIds = new Set(eligibleRepos.map((repo) => repo.id))
  const hostById = new Map(hosts.map((host) => [host.id, host]))
  return projectHostSetups
    .filter((setup) => {
      const host = hostById.get(setup.hostId)
      return (
        setup.projectId === projectId &&
        setup.setupState === 'ready' &&
        eligibleRepoIds.has(setup.repoId) &&
        !isEphemeralVmProjectHost(host) &&
        !isRuntimeOwnedSshSetupHost(setup.hostId)
      )
    })
    .map((setup) => ({
      id: setup.id,
      kind: 'ready' as const,
      projectId: setup.projectId,
      hostId: setup.hostId,
      repoId: setup.repoId,
      label: hostById.get(setup.hostId)?.label || getExecutionHostLabel(setup.hostId),
      detail: setup.displayName,
      path: setup.path
    }))
}

function buildNeedsSetupOptions({
  projectId,
  hosts,
  readySetupByHost,
  pendingSetupByHost
}: BuildNeedsSetupOptionsInput): NeedsSetupProjectHostOption[] {
  return hosts
    .filter(
      (host) =>
        !readySetupByHost.has(host.id) &&
        !isEphemeralVmProjectHost(host) &&
        !isRuntimeOwnedSshSetupHost(host.id)
    )
    .map((host) => {
      const pendingSetup = pendingSetupByHost.get(host.id)
      const availability = getHostSetupAvailability(host)
      const connectAction = getHostConnectAction(host)
      return {
        id: `needs-setup:${host.id}`,
        kind: 'needs-setup' as const,
        projectId,
        hostId: host.id,
        label: host.label || getExecutionHostLabel(host.id),
        detail: availability.isAvailable
          ? pendingSetup
            ? getPendingSetupDetail(pendingSetup)
            : 'Project not set up on this host'
          : availability.detail,
        isAvailable: availability.isAvailable,
        attention: host.health === 'error',
        ...(connectAction ? { connectAction } : {})
      }
    })
}

function isEphemeralVmProjectHost(host: ExecutionHostRegistryEntry | undefined): boolean {
  return host?.kind === 'runtime' && isEphemeralVmRuntimeEnvironment(host)
}

// Why: a per-workspace-env SSH repo projects a setup with hostId `ssh:runtime-ssh-<id>`. The
// execution-host registry filters runtime-owned targets, so its host is absent here — guard on the
// hostId directly so the hidden target never becomes a selectable run-target option.
function isRuntimeOwnedSshSetupHost(hostId: ExecutionHostId): boolean {
  const parsed = parseExecutionHostId(hostId)
  return parsed?.kind === 'ssh' && isRuntimeOwnedSshTargetId(parsed.targetId)
}

function getHostSetupAvailability(host: ExecutionHostRegistryEntry): {
  isAvailable: boolean
  detail: string
} {
  if (host.health === 'blocked') {
    return {
      isAvailable: false,
      detail: 'Orca server version is incompatible'
    }
  }
  // Why: disconnected hosts cannot confirm project setup or runtime capabilities,
  // so connection state needs to win over setup guidance.
  const healthUnavailableDetail = getHostHealthUnavailableDetail(host.health)
  if (healthUnavailableDetail) {
    return {
      isAvailable: false,
      detail: healthUnavailableDetail
    }
  }
  if (host.kind === 'runtime') {
    if (!host.capabilities) {
      return {
        isAvailable: false,
        detail: 'Checking host capabilities'
      }
    }
    if (
      !host.capabilities.includes(PROJECT_HOST_SETUP_RUNTIME_CAPABILITY) ||
      !host.capabilities.includes(WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY)
    ) {
      return {
        isAvailable: false,
        detail: 'Update Orca on this host to set up projects'
      }
    }
  }
  return {
    isAvailable: true,
    detail: ''
  }
}

function getHostHealthUnavailableDetail(
  health: ExecutionHostRegistryEntry['health']
): string | null {
  switch (health) {
    case 'connecting':
      return 'Connecting to host'
    case 'disconnected':
      return 'Connect this host to set up projects'
    case 'error':
      return 'Host connection needs attention'
    case 'available':
    case 'blocked':
    case 'local':
      return null
  }
}

function getHostConnectAction(
  host: ExecutionHostRegistryEntry
): NeedsSetupProjectHostOption['connectAction'] | undefined {
  if (host.health !== 'disconnected' && host.health !== 'error') {
    return undefined
  }
  const parsed = parseExecutionHostId(host.id)
  if (parsed?.kind === 'ssh') {
    return { kind: 'ssh', targetId: parsed.targetId }
  }
  if (parsed?.kind === 'runtime') {
    return { kind: 'runtime', environmentId: parsed.environmentId }
  }
  return undefined
}

function getPendingSetupDetail(setup: ProjectHostSetup): string {
  switch (setup.setupState) {
    case 'not-set-up':
      return 'Project tracked on this host but not set up'
    case 'setting-up':
      return 'Project setup is in progress'
    case 'error':
      return 'Project setup needs attention'
    case 'unsupported':
      return 'Project is unsupported on this host'
    case 'ready':
      return setup.path
  }
}

function compareProjectHostSetupOptions(
  a: ProjectHostSetupOption,
  b: ProjectHostSetupOption
): number {
  if (a.hostId === LOCAL_EXECUTION_HOST_ID && b.hostId !== LOCAL_EXECUTION_HOST_ID) {
    return -1
  }
  if (b.hostId === LOCAL_EXECUTION_HOST_ID && a.hostId !== LOCAL_EXECUTION_HOST_ID) {
    return 1
  }
  const aDetail = a.kind === 'ready' ? a.path : a.detail
  const bDetail = b.kind === 'ready' ? b.path : b.detail
  return a.label.localeCompare(b.label) || aDetail.localeCompare(bDetail)
}
