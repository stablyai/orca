import {
  getExecutionHostLabel,
  isRuntimeOwnedSshTargetId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { ExecutionHostRegistryEntry } from '../../../shared/execution-host-registry'
import { isHostLocalProjectId } from '../../../shared/project-host-setup-projection'
import { isEphemeralVmRuntimeEnvironment } from '../../../shared/runtime-environments'
import { isMergedAwayExecutionHost } from '../../../shared/managed-orcad-execution-host'
import {
  PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
  WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import type { ProjectHostSetup } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import { translate } from '@/i18n/i18n'
import { dedupeReadySetupRows } from './project-host-setup-row-dedupe'

export type ProjectHostSetupSelection = { id: string; hostId: ExecutionHostId }

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
      /** Same-checkout setups on this machine's other host id that this row stands for. */
      aliasSetups?: readonly ProjectHostSetupSelection[]
    }
  | {
      id: string
      kind: 'needs-setup'
      projectId: string
      hostId: ExecutionHostId
      label: string
      detail: string
      isAvailable: boolean
      // Only connection errors warrant alarm; dormant disconnected hosts are not broken.
      attention: boolean
      // Available pathless hosts can set up in place; connecting/in-progress/unsupported hosts need another step.
      canSetLocation: boolean
      connectAction?: { kind: 'ssh'; targetId: string } | { kind: 'runtime'; environmentId: string }
    }

export type ReadyProjectHostSetupOption = Extract<ProjectHostSetupOption, { kind: 'ready' }>

export type NeedsSetupProjectHostOption = Extract<ProjectHostSetupOption, { kind: 'needs-setup' }>

export function getProjectHostSetupSelectionKey(
  option: Pick<ProjectHostSetupOption, 'id' | 'hostId'>
): string {
  return JSON.stringify([option.id, option.hostId])
}

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
  hosts: readonly ExecutionHostRegistryEntry[]
}

export function buildProjectHostSetupOptions({
  projectId,
  projectHostSetups,
  eligibleRepos,
  hosts
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
  const options = projectHostSetups
    .filter((setup) => {
      const host = hostById.get(setup.hostId)
      return (
        setup.projectId === projectId &&
        setup.setupState === 'ready' &&
        eligibleRepoIds.has(setup.repoId) &&
        Boolean(host) &&
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
  return dedupeReadySetupRows(options, hostById)
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
        !isRuntimeOwnedSshSetupHost(host.id) &&
        !isMergedAwayExecutionHost(host) &&
        // Why: a machine whose other id already holds the project shows that ready row only.
        !host.aliasHostIds?.some((aliasHostId) => readySetupByHost.has(aliasHostId))
    )
    .map((host) => {
      const pendingSetup = pendingSetupByHost.get(host.id)
      // Disconnected hosts cannot confirm setup/capabilities; connection state takes precedence.
      const unavailableDetail =
        getHostHealthUnavailableDetail(host.health) ?? getHostSetupUnavailableDetail(host)
      const isAvailable = unavailableDetail === null
      const connectAction = getHostConnectAction(host)
      return {
        id: `needs-setup:${host.id}`,
        kind: 'needs-setup' as const,
        projectId,
        hostId: host.id,
        label: host.label || getExecutionHostLabel(host.id),
        detail:
          unavailableDetail ??
          (pendingSetup ? getPendingSetupDetail(pendingSetup) : 'Project location not set'),
        isAvailable,
        attention: host.health === 'error',
        canSetLocation: canSetProjectLocation(projectId, isAvailable, pendingSetup),
        ...(connectAction ? { connectAction } : {})
      }
    })
}

function isEphemeralVmProjectHost(host: ExecutionHostRegistryEntry | undefined): boolean {
  return host?.kind === 'runtime' && isEphemeralVmRuntimeEnvironment(host)
}

// Runtime-owned ephemeral SSH setups lack host-registry rows; check raw hostId to keep them out of run targets.
function isRuntimeOwnedSshSetupHost(hostId: ExecutionHostId): boolean {
  const parsed = parseExecutionHostId(hostId)
  return parsed?.kind === 'ssh' && isRuntimeOwnedSshTargetId(parsed.targetId)
}

export function getHostSetupUnavailableDetail(host: ExecutionHostRegistryEntry): string | null {
  if (host.health === 'blocked') {
    return translate(
      'auto.components.settings.RepositoryPane.hostSetupBlockedVersion',
      'Orca server version is incompatible'
    )
  }
  if (host.kind !== 'runtime') {
    return null
  }
  if (!host.capabilities) {
    return translate(
      'auto.components.settings.RepositoryPane.hostSetupCheckingCapability',
      'Checking host capabilities'
    )
  }
  if (
    !host.capabilities.includes(PROJECT_HOST_SETUP_RUNTIME_CAPABILITY) ||
    !host.capabilities.includes(WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY)
  ) {
    return translate(
      'auto.components.settings.RepositoryPane.hostSetupMissingCapability',
      'Update Orca on this host to set up projects'
    )
  }
  return null
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

function canSetProjectLocation(
  projectId: string,
  isAvailable: boolean,
  pendingSetup: ProjectHostSetup | undefined
): boolean {
  // Cross-host setup links project identity; host-local repo:<id> has no match, so show status instead of a guaranteed error button.
  if (!isAvailable || isHostLocalProjectId(projectId)) {
    return false
  }
  if (!pendingSetup) {
    return true
  }
  return pendingSetup.setupState === 'not-set-up' || pendingSetup.setupState === 'error'
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
