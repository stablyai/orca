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
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/host-section-rows'
import { getHostContextLabel } from '../../../../../../shared/worktree/host-context-labels'
import type { ExecutionHostRegistryEntry } from '../../../../../../shared/execution-host-registry'
import type { SshConnectionState } from '../../../../../../shared/ssh-types'

type ProjectGroupHostRecord = Pick<ProjectGroup, 'id' | 'connectionId' | 'executionHostId'>

export type ProjectHeaderHostContext = {
  hostId: ExecutionHostId
  label: string
  detail: string
}

type HostContextSources = {
  hosts: readonly ExecutionHostRegistryEntry[]
  runtimeEnvironments?: readonly ManagedOrcadEnvironmentSummary[]
  sshConnectionStates?: ReadonlyMap<string, Pick<SshConnectionState, 'managedServer'>>
}

type HostContextResolver = {
  canonicalHostId: (hostId: ExecutionHostId) => ExecutionHostId
  contextFor: (hostId: ExecutionHostId) => ProjectHeaderHostContext
}

function createHostContextResolver(sources: HostContextSources): HostContextResolver {
  const hostRegistry = new Map(sources.hosts.map((host) => [host.id, host]))
  annotateManagedOrcadExecutionHosts({
    hosts: hostRegistry,
    // Preserve authoritative aliases; feed options need owner configuration to fill them in.
    runtimeEnvironments: (sources.runtimeEnvironments ?? []).filter((environment) => {
      const host = hostRegistry.get(toRuntimeExecutionHostId(environment.id))
      return !host?.mergedIntoHostId && !host?.aliasHostIds?.length
    }),
    sshConnectionStates: sources.sshConnectionStates
  })
  const hostsById = indexExecutionHostsById([...hostRegistry.values()])
  const canonicalHostId = (hostId: ExecutionHostId): ExecutionHostId =>
    hostsById.get(hostId)?.id ?? hostId
  return {
    canonicalHostId,
    contextFor: (hostId) => {
      const canonical = canonicalHostId(hostId)
      const host = hostsById.get(canonical)
      return {
        hostId: canonical,
        label: host?.label ?? getHostContextLabel(canonical),
        detail: host?.detail ?? getHostContextLabel(canonical)
      }
    }
  }
}

/** Each project group's computer, in the groups' order; empty unless the groups span computers. */
export function getProjectGroupHostContexts(
  args: HostContextSources & { groups: readonly ProjectGroupHostRecord[] }
): readonly ProjectHeaderHostContext[] {
  const resolver = createHostContextResolver(args)
  // Why: by position, since same-id copies of a group can sit on several computers (#30045).
  const contexts = args.groups.map((group) => resolver.contextFor(getRepoExecutionHostId(group)))
  // Why: a group lives on the computer that made it, which only matters once groups come from several.
  return new Set(contexts.map(({ hostId }) => hostId)).size > 1 ? contexts : []
}

export function getProjectHeaderHostContexts(
  args: HostContextSources & {
    rows: readonly HostSectionRow[]
    visibleProjectRepoIdsBySection?: ReadonlyMap<string, ReadonlySet<string>>
    repoMap: Map<string, Repo>
    projectGrouping?: ProjectGroupingModel
  }
): ReadonlyMap<string, ProjectHeaderHostContext> {
  const resolver = createHostContextResolver(args)
  const { canonicalHostId } = resolver
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
    const context = resolver.contextFor(ownerHostId)
    labelHosts.add(context.hostId)
    candidates.set(row.key, context)
  }
  // Only colliding names across machines need a host label.
  return new Map(
    [...candidates].filter(([key]) => (hostsByLabel.get(sectionLabels.get(key)!)?.size ?? 0) > 1)
  )
}
