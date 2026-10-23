import {
  getRepoExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import {
  annotateManagedOrcadExecutionHosts,
  indexExecutionHostsById,
  type ManagedOrcadEnvironmentSummary
} from '../../../../../../shared/managed-orcad-execution-host'
import {
  buildProjectGroupingIndex,
  getProjectGroupingForRepo,
  type ProjectGroupingModel
} from '../../../../../../shared/project-section-grouping'
import type { Repo } from '../../../../../../shared/repo-types'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/host-section-rows'
import { getHostContextLabel } from '../../../../../../shared/worktree/host-context-labels'
import type { ExecutionHostRegistryEntry } from '../../../../../../shared/execution-host-registry'
import type { SshConnectionState } from '../../../../../../shared/ssh-types'

export type ProjectHeaderHostContext = {
  hostId: ExecutionHostId
  label: string
  detail: string
}

export function getProjectHeaderHostContexts(args: {
  rows: readonly HostSectionRow[]
  visibleProjectRepoIdsBySection?: ReadonlyMap<string, ReadonlySet<string>>
  hosts: readonly ExecutionHostRegistryEntry[]
  runtimeEnvironments?: readonly ManagedOrcadEnvironmentSummary[]
  sshConnectionStates?: ReadonlyMap<string, Pick<SshConnectionState, 'managedServer'>>
  repoMap: Map<string, Repo>
  projectGrouping?: ProjectGroupingModel
}): ReadonlyMap<string, ProjectHeaderHostContext> {
  const hostRegistry = new Map(args.hosts.map((host) => [host.id, host]))
  annotateManagedOrcadExecutionHosts({
    hosts: hostRegistry,
    // Preserve authoritative aliases; feed options need owner configuration to fill them in.
    runtimeEnvironments: (args.runtimeEnvironments ?? []).filter((environment) => {
      const host = hostRegistry.get(toRuntimeExecutionHostId(environment.id))
      return !host?.mergedIntoHostId && !host?.aliasHostIds?.length
    }),
    sshConnectionStates: args.sshConnectionStates
  })
  const hostsById = indexExecutionHostsById([...hostRegistry.values()])
  const canonicalHostId = (hostId: ExecutionHostId): ExecutionHostId =>
    hostsById.get(hostId)?.id ?? hostId
  const projectIndex = buildProjectGroupingIndex(args.projectGrouping)
  const repoHostId = (repo: Repo): ExecutionHostId =>
    canonicalHostId(
      projectIndex?.setupByRepoId.get(repo.id)?.hostId ?? getRepoExecutionHostId(repo)
    )
  const hostsByProjectKey = new Map<string, Set<ExecutionHostId>>()
  for (const repo of args.repoMap.values()) {
    const key = getProjectGroupingForRepo(repo.id, args.repoMap, projectIndex).key
    const hostId = repoHostId(repo)
    const projectHosts = hostsByProjectKey.get(key) ?? new Set<ExecutionHostId>()
    projectHosts.add(hostId)
    hostsByProjectKey.set(key, projectHosts)
  }
  const candidates = new Map<string, ProjectHeaderHostContext>()
  const sectionLabels = new Map<string, string>()
  const hostsByLabel = new Map<string, Set<ExecutionHostId>>()
  for (const row of args.rows) {
    // Host sections already identify every following project header.
    if (row.type === 'host-header') {
      break
    }
    if (row.type !== 'header' || row.icon.kind !== 'project') {
      continue
    }
    const label = row.label
    if (!label) {
      continue
    }
    sectionLabels.set(row.key, label)
    const labelHosts = hostsByLabel.get(label) ?? new Set<ExecutionHostId>()
    hostsByLabel.set(label, labelHosts)
    let ownerHostId: ExecutionHostId
    if (row.repo) {
      const projectHosts = hostsByProjectKey.get(row.key)
      // A logical project can contain checkouts on several machines.
      if (projectHosts && projectHosts.size > 1) {
        const visibleRepoIds = args.visibleProjectRepoIdsBySection?.get(row.key)
        const visibleProjectHosts = visibleRepoIds
          ? [...visibleRepoIds].flatMap((repoId) => {
              const repo = args.repoMap.get(repoId)
              return repo ? [repoHostId(repo)] : []
            })
          : projectHosts
        for (const hostId of visibleProjectHosts) {
          labelHosts.add(hostId)
        }
        continue
      }
      ownerHostId = projectHosts?.values().next().value ?? getRepoExecutionHostId(row.repo)
    } else if (
      row.projectGroup &&
      'createdFrom' in row.projectGroup &&
      row.projectGroup.createdFrom === 'folder-scan' &&
      row.projectGroup.parentPath
    ) {
      ownerHostId = getRepoExecutionHostId(row.projectGroup)
    } else {
      continue
    }
    const hostId = canonicalHostId(ownerHostId)
    labelHosts.add(hostId)
    const host = hostsById.get(hostId)
    candidates.set(row.key, {
      hostId,
      label: host?.label ?? getHostContextLabel(hostId),
      detail: host?.detail ?? getHostContextLabel(hostId)
    })
  }
  // Only colliding names across machines need a host label.
  return new Map(
    [...candidates].filter(([key]) => (hostsByLabel.get(sectionLabels.get(key)!)?.size ?? 0) > 1)
  )
}
