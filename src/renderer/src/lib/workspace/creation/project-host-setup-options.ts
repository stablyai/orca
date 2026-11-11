import { buildProjectSetupRepoLookup } from '../../project-setup-repo-lookup'
import type { ProjectGroupingSettings } from '../../../../../shared/project-grouping'
import {
  buildProjectGroupingIndex,
  type ProjectGroupingIndex
} from '../../../../../shared/project-section-grouping'
import {
  getExecutionHostLabel,
  isRuntimeOwnedSshTargetId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host'
import type { ExecutionHostRegistryEntry } from '../../../../../shared/execution-host/execution-host-registry-entry'
import { getHostHealthUnavailableDetail } from './project-host-health-detail'
import { isHostLocalProjectId } from '../../../../../shared/project-host-setup-projection'
import { isEphemeralVmRuntimeEnvironment } from '../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { isMergedAwayExecutionHost } from '../../../../../shared/execution-host/managed-orcad-execution-host'
import '../../../../../shared/protocol-version'
import {
  PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
  WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY
} from '../../../../../shared/worktree-runtime-capabilities'
import type { ProjectHostSetup } from '../../../../../shared/project-types'
import type { Repo } from '../../../../../shared/repo-types'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { getPendingSetupDetail } from '../../project-host-setup-detail-labels'
import { translateHostDisplayLabel } from '@/components/sidebar/execution-host-label'
import {
  dedupeReadySetupRows,
  compareProjectHostSetupOptions,
  type SelectedProjectHostSetup
} from './project-host-setup-row-dedupe'

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
  projectHostSetups: readonly ProjectHostSetup[]
  eligibleRepos: readonly Repo[]
  hosts: readonly ExecutionHostRegistryEntry[]
  selectedSetup?: SelectedProjectHostSetup | null
}

type BuildNeedsSetupOptionsInput = {
  projectId: string
  hosts: readonly ExecutionHostRegistryEntry[]
  readySetupByHost: ReadonlyMap<ExecutionHostId, ReadyProjectHostSetupOption>
  pendingSetupByHost: ReadonlyMap<ExecutionHostId, ProjectHostSetup>
}

type BuildProjectHostSetupOptionsInput = {
  groupKey?: string | null
  grouping?: ProjectGroupingIndex
  settings?: ProjectGroupingSettings | null
  projectId: string | null
  projectHostSetups: readonly ProjectHostSetup[]
  eligibleRepos: readonly Repo[]
  hosts: readonly ExecutionHostRegistryEntry[]
  /** Shown as its host's row when that host has several checkouts of the project. */
  selectedSetup?: SelectedProjectHostSetup | null
}

export function buildProjectHostSetupOptions({
  groupKey,
  grouping,
  settings,
  projectId,
  projectHostSetups,
  eligibleRepos,
  hosts,
  selectedSetup
}: BuildProjectHostSetupOptionsInput): ProjectHostSetupOption[] {
  if (!projectId) {
    return []
  }
  const index =
    grouping ??
    buildProjectGroupingIndex({
      projects: [{ id: projectId, displayName: '' }],
      projectHostSetups,
      settings
    })
  const group = groupKey ? index.groupByKey.get(groupKey) : undefined
  const groupedSetups = projectHostSetups.filter((setup) =>
    group
      ? index.groupByRepoHost.get(`${setup.hostId}\0${setup.repoId}`)?.key === group.key
      : setup.projectId === projectId
  )
  const readyOptions = buildReadyProjectHostSetupOptions({
    projectHostSetups: groupedSetups,
    eligibleRepos,
    hosts,
    selectedSetup
  })
  const readySetupByHost = new Map(readyOptions.map((option) => [option.hostId, option]))
  const pendingSetupByHost = getPendingSetupByHost(groupedSetups)
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
  projectHostSetups: readonly ProjectHostSetup[]
): Map<ExecutionHostId, ProjectHostSetup> {
  const setups = new Map<ExecutionHostId, ProjectHostSetup>()
  for (const setup of projectHostSetups) {
    if (setup.setupState === 'ready') {
      continue
    }
    if (!setups.has(setup.hostId)) {
      setups.set(setup.hostId, setup)
    }
  }
  return setups
}

export function buildReadyProjectHostSetupOptions({
  projectHostSetups,
  eligibleRepos,
  hosts,
  selectedSetup
}: BuildReadySetupOptionsInput): ReadyProjectHostSetupOption[] {
  const repoLookup = buildProjectSetupRepoLookup(eligibleRepos)
  const hostById = new Map(hosts.map((host) => [host.id, host]))
  const options = projectHostSetups
    .filter((setup) => {
      const host = hostById.get(setup.hostId)
      return (
        setup.setupState === 'ready' &&
        Boolean(repoLookup.resolve(setup)) &&
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
      label: hostById.get(setup.hostId)
        ? translateHostDisplayLabel(hostById.get(setup.hostId)!)
        : getExecutionHostLabel(setup.hostId),
      detail: setup.displayName,
      path: setup.path
    }))
  return dedupeReadySetupRows(options, hostById, selectedSetup)
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
        label: host.label ? translateHostDisplayLabel(host) : getExecutionHostLabel(host.id),
        detail:
          unavailableDetail ??
          (pendingSetup
            ? getPendingSetupDetail(pendingSetup)
            : translate(
                'auto.lib.projectHostSetupOptions.locationNotSet',
                'Project location not set'
              )),
        isAvailable,
        attention: host.health === 'error',
        canSetLocation: canSetProjectLocation(projectId, isAvailable, pendingSetup),
        ...(connectAction ? { connectAction } : {})
      }
    })
}

export function isEphemeralVmProjectHost(host: ExecutionHostRegistryEntry | undefined): boolean {
  return host?.kind === 'runtime' && isEphemeralVmRuntimeEnvironment(host)
}

// Runtime-owned ephemeral SSH setups lack host-registry rows; check raw hostId to keep them out of run targets.
function isRuntimeOwnedSshSetupHost(hostId: ExecutionHostId): boolean {
  const parsed = parseExecutionHostId(hostId)
  return parsed?.kind === 'ssh' && isRuntimeOwnedSshTargetId(parsed.targetId)
}

export function getHostSetupUnavailableDetail(
  host: ExecutionHostRegistryEntry,
  t: Translate = translate
): string | null {
  if (host.health === 'blocked') {
    return t(
      'auto.components.settings.RepositoryPane.hostSetupBlockedVersion',
      'Orca server version is incompatible'
    )
  }
  if (host.kind !== 'runtime') {
    return null
  }
  if (!host.capabilities) {
    return t(
      'auto.components.settings.RepositoryPane.hostSetupCheckingCapability',
      'Checking host capabilities'
    )
  }
  if (
    !host.capabilities.includes(PROJECT_HOST_SETUP_RUNTIME_CAPABILITY) ||
    !host.capabilities.includes(WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY)
  ) {
    return t(
      'auto.components.settings.RepositoryPane.hostSetupMissingCapability',
      'Update Orca on this host to set up projects'
    )
  }
  return null
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
