import {
  getExecutionHostLabel,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { ExecutionHostRegistryEntry } from '../../../shared/execution-host-registry'
import { parseWslUncPath } from '../../../shared/wsl-paths'
import type { ProjectHostSetup } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import { translate } from '@/i18n/i18n'
import {
  getHostConnectAction,
  getHostSetupAvailability,
  getPendingSetupDetail,
  isEphemeralVmProjectHost,
  isRuntimeOwnedSshSetupHost,
  canSetProjectLocation
} from './project-host-setup-availability'

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
      // Why: available hosts without a path can be set up in place; connecting or
      // in-progress/unsupported hosts need a different next step.
      canSetLocation: boolean
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
  return projectHostSetups
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
    .map((setup) => {
      const host = hostById.get(setup.hostId)
      const hostLabel = host?.label || getExecutionHostLabel(setup.hostId)
      // Why: a WSL-UNC setup path is where the worktree mirror lands, so the
      // run-target row names the storage distro instead of reading as Windows.
      // Scoped to local by product decision: this series ships the WSL runtime
      // only for the local Windows host, so the label follows the same scope. A
      // Windows SSH host can also report a \\wsl.localhost path — labelling that
      // is deferred with the rest of the remote-WSL story.
      const storageDistro =
        host?.kind === 'local' ? (parseWslUncPath(setup.path)?.distro ?? null) : null
      return {
        id: setup.id,
        kind: 'ready' as const,
        projectId: setup.projectId,
        hostId: setup.hostId,
        repoId: setup.repoId,
        label: storageDistro
          ? translate(
              'auto.lib.projectHostSetupOptions.wslStorageLabel',
              '{{value0}} · WSL ({{distro}})',
              { value0: hostLabel, distro: storageDistro }
            )
          : hostLabel,
        detail: setup.displayName,
        path: setup.path
      }
    })
    .filter(dedupeByHost())
}

// Why: a project resolves to at most one setup per host — resolveWorkspaceCreationTarget takes the
// first project+host match and ignores the rest, so extra same-host setups are unreachable. Legacy
// profiles can still hold them (a linked worktree added as its own project projects a second local
// setup), which rendered as repeated identical "Local Mac" rows. Keep the first in input order so
// the row shown is the one workspace creation actually uses.
function dedupeByHost(): (option: ReadyProjectHostSetupOption) => boolean {
  const seenHosts = new Set<ExecutionHostId>()
  return (option) => {
    if (seenHosts.has(option.hostId)) {
      return false
    }
    seenHosts.add(option.hostId)
    return true
  }
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
            : 'Project location not set'
          : availability.detail,
        isAvailable: availability.isAvailable,
        attention: host.health === 'error',
        canSetLocation: canSetProjectLocation(projectId, availability.isAvailable, pendingSetup),
        ...(connectAction ? { connectAction } : {})
      }
    })
}

// Why: a per-workspace-env SSH repo projects a setup with hostId `ssh:runtime-ssh-<id>`. The
// execution-host registry filters runtime-owned targets, so its host is absent here — guard on the
// hostId directly so the hidden target never becomes a selectable run-target option.
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
