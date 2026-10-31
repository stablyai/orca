import type { SectionAppendContext } from './section-append-context'
import type {
  Row,
  ImportedWorktreesCardCandidate,
  NewExternalWorktreesInboxCandidate
} from './row-types'
import type { WorktreeGroupEntry, OrderedGroupEntry } from './worktree-group-entry'

import { getRepoHostIdentity, getRepoHostIdentityForParts } from '../repo-host-identity'
import {
  getRepoExecutionHostId,
  getRepoExecutionHostIdOrDefault,
  getWorktreeExecutionHostId,
  type ExecutionHostId
} from '../execution-host'
import { getProjectGroupingForRepo } from '../project-section-grouping'
import type { Repo } from '../repo-types'

import { getWorkspaceStatusFromGroupKey } from '../workspace-statuses'
import type { PRGroupKey } from './group-keys'
import {
  getLaneHostWorktreeCounts,
  getLaneHostWorktreeIds,
  getMixedHostContextLabels,
  getProjectHeaderHostScope
} from './host-labels'

import {
  appendWorktreeRows,
  buildFolderWorkspaceRow,
  buildImportedWorktreesCardRow,
  buildNewExternalWorktreesInboxRow,
  buildPendingCreationRow
} from './row-builders'

export type { SectionAppendContext } from './section-append-context'

function prepareProjectSection(ctx: SectionAppendContext, key: string, group: WorktreeGroupEntry) {
  const registrations = ctx.projectIndex?.groupByKey.get(key)?.registrations
  const owns = (repo: Repo) => {
    const indexedOwner = ctx.projectIndex?.groupByRepoHost.get(getRepoHostIdentity(repo))
    if (indexedOwner) {
      return indexedOwner.key === key
    }
    return (
      !registrations &&
      getProjectGroupingForRepo(
        repo.id,
        ctx.repoMap,
        ctx.projectIndex,
        getRepoExecutionHostId(repo),
        ctx.repoByHost
      ).key === key
    )
  }
  const firstRepoByHost = new Map<ExecutionHostId, Repo>()
  const retainFirstRepoForHost = (repo: Repo) => {
    const host = getRepoExecutionHostIdOrDefault(repo, ctx.defaultHostId)
    if (!firstRepoByHost.has(host)) {
      firstRepoByHost.set(host, repo)
    }
  }
  const offer = (repo: Repo | undefined) => {
    if (repo && owns(repo)) {
      retainFirstRepoForHost(repo)
    }
  }
  const observedHostIds = new Set<ExecutionHostId>()
  offer(group.repo)
  for (const worktree of group.items) {
    const repo = ctx.repoOf(worktree)
    observedHostIds.add(getWorktreeExecutionHostId(worktree, repo, ctx.defaultHostId))
    offer(repo)
  }
  const repoIds =
    group.repoIds.size > 0
      ? [...group.repoIds]
      : group.repo
        ? [group.repo.id]
        : key.startsWith('repo:')
          ? [key.slice('repo:'.length)]
          : []
  const pendingKeys = registrations
    ? registrations.map((setup) => getRepoHostIdentityForParts(setup.repoId, setup.hostId))
    : (group.pendingBucketRefs ?? [])
  const pendingRows: Row[] = []
  const pendingHostsByRepo = new Map<string, ExecutionHostId[]>()
  for (const identity of new Set(pendingKeys)) {
    for (const creation of ctx.pendingByRepo.get(identity) ?? []) {
      const row = buildPendingCreationRow(creation, ctx.repoMap, ctx.repoByHost)
      pendingRows.push(row)
      const hosts = pendingHostsByRepo.get(creation.repoId) ?? []
      hosts.push(getRepoExecutionHostIdOrDefault(row.repo, ctx.defaultHostId))
      pendingHostsByRepo.set(creation.repoId, hosts)
    }
  }
  const importedRows: Row[] = []
  const externalRows: Row[] = []
  const importedById = new Map<string, ImportedWorktreesCardCandidate[]>()
  const externalById = new Map<string, NewExternalWorktreesInboxCandidate[]>()
  for (const ref of group.noticeRefs ?? []) {
    if (ref.kind === 'imported') {
      const candidates = importedById.get(ref.candidate.repo.id) ?? []
      candidates.push(ref.candidate)
      importedById.set(ref.candidate.repo.id, candidates)
    } else {
      const candidates = externalById.get(ref.candidate.repo.id) ?? []
      candidates.push(ref.candidate)
      externalById.set(ref.candidate.repo.id, candidates)
    }
  }
  for (const id of repoIds) {
    offer(ctx.repoMap.get(id))
    for (const host of pendingHostsByRepo.get(id) ?? []) {
      observedHostIds.add(host)
    }
    pendingHostsByRepo.delete(id)
    for (const imported of importedById.get(id) ?? []) {
      importedRows.push(
        buildImportedWorktreesCardRow(
          imported,
          'repo-group',
          ctx.noticeHostContextLabelByRepoId?.get(getRepoHostIdentity(imported.repo))
        )
      )
      observedHostIds.add(getRepoExecutionHostIdOrDefault(imported.repo, ctx.defaultHostId))
      retainFirstRepoForHost(imported.repo)
    }
    for (const external of externalById.get(id) ?? []) {
      externalRows.push(
        buildNewExternalWorktreesInboxRow(
          external,
          ctx.noticeHostContextLabelByRepoId?.get(getRepoHostIdentity(external.repo))
        )
      )
      observedHostIds.add(getRepoExecutionHostIdOrDefault(external.repo, ctx.defaultHostId))
      retainFirstRepoForHost(external.repo)
    }
  }
  for (const hosts of pendingHostsByRepo.values()) {
    for (const host of hosts) {
      observedHostIds.add(host)
    }
  }
  for (const setup of registrations ?? []) {
    const raw = ctx.repoMap.get(setup.repoId)
    offer(
      ctx.repoByHost?.get(getRepoHostIdentityForParts(setup.repoId, setup.hostId)) ??
        (raw && getRepoExecutionHostId(raw) === setup.hostId ? raw : undefined)
    )
  }
  for (const row of pendingRows) {
    if (row.type === 'pending-creation') {
      offer(row.repo)
    }
  }
  return {
    repo: group.repo && owns(group.repo) ? group.repo : undefined,
    displayRepo: group.displayRepo,
    contextRepo: firstRepoByHost.values().next().value,
    projectScope: registrations
      ? {
          key,
          catalogHostId: group.repo ? getRepoExecutionHostId(group.repo) : undefined,
          registrations,
          context: (() => {
            const context = firstRepoByHost.values().next().value
            if (!context) {
              return undefined
            }
            const hostId = getRepoExecutionHostId(context)
            const setup = ctx.projectIndex?.setupByRepoHost.get(getRepoHostIdentity(context))
            return { repoId: context.id, hostId, ...(setup ? { setupId: setup.id } : {}) }
          })()
        }
      : undefined,
    anchorHostId: getRepoExecutionHostIdOrDefault(group.repo, ctx.defaultHostId),
    observedHostIds,
    labelHostIds: new Set([
      ...(registrations?.map((setup) => setup.hostId) ?? []),
      ...firstRepoByHost.keys(),
      ...observedHostIds
    ]),
    firstRepoByHost,
    rows: importedRows.concat(externalRows, pendingRows)
  }
}

export function appendOrderedGroups(
  ctx: SectionAppendContext,
  groupsToAppend: OrderedGroupEntry[],
  projectGroupDepth = 0
): void {
  const {
    result,
    groupBy,
    collapsedGroups,
    workspaceStatuses,
    workspaceStatusById,
    repoOf,
    defaultHostId,
    hostLabelById,
    mixedWorktreeHostContextLabels,
    occurrencePlan
  } = ctx
  for (const [key, group] of groupsToAppend) {
    const isCollapsed = collapsedGroups.has(key)
    const section = groupBy === 'repo' ? prepareProjectSection(ctx, key, group) : undefined
    const repo = section ? section.repo : group.repo
    const folderPairs = group.folderWorkspaces ?? []
    const header =
      groupBy === 'repo'
        ? {
            type: 'header' as const,
            key,
            label: group.label,
            count: group.items.length,
            icon: { kind: 'project' as const },
            repo,
            displayRepo: section?.displayRepo,
            contextRepo: section?.contextRepo,
            projectScope: section?.projectScope,
            projectGroupDepth,
            ...(section ? getProjectHeaderHostScope(ctx, group, section) : {})
          }
        : groupBy === 'workspace-status'
          ? (() => {
              const workspaceStatus =
                getWorkspaceStatusFromGroupKey(key, workspaceStatuses, workspaceStatusById) ??
                workspaceStatuses[0]?.id ??
                'in-progress'
              const definition = workspaceStatusById
                ? workspaceStatusById.get(workspaceStatus)
                : workspaceStatuses.find((status) => status.id === workspaceStatus)
              return {
                type: 'header' as const,
                key,
                label: definition?.label ?? workspaceStatus,
                count: group.items.length + folderPairs.length,
                icon: { kind: 'workspace-status' as const, status: workspaceStatus },
                hostWorktreeCounts: getLaneHostWorktreeCounts(
                  group.items,
                  folderPairs,
                  repoOf,
                  defaultHostId
                ),
                hostWorktreeIds: getLaneHostWorktreeIds(
                  group.items,
                  folderPairs,
                  repoOf,
                  defaultHostId
                ),
                worktreeIds: group.items.map((worktree) => worktree.id)
              }
            })()
          : (() => {
              const prGroup = key.replace(/^pr:/, '') as PRGroupKey
              return {
                type: 'header' as const,
                key,
                count: group.items.length + folderPairs.length,
                icon: { kind: 'pr-status' as const, prGroup },
                hostWorktreeCounts: getLaneHostWorktreeCounts(
                  group.items,
                  folderPairs,
                  repoOf,
                  defaultHostId
                ),
                hostWorktreeIds: getLaneHostWorktreeIds(
                  group.items,
                  folderPairs,
                  repoOf,
                  defaultHostId
                ),
                worktreeIds: group.items.map((worktree) => worktree.id)
              }
            })()

    result.push(header)
    if (!isCollapsed) {
      for (const row of section?.rows ?? []) {
        result.push(row)
      }
      const hostContextLabelByHostId = section
        ? getMixedHostContextLabels(section.labelHostIds, hostLabelById)
        : undefined
      appendWorktreeRows(result, repoOf, occurrencePlan, {
        collapsedGroups,
        groupDepth: projectGroupDepth,
        sectionKey: key,
        hostContextLabelByHostId,
        defaultHostId,
        hostContextLabelByWorktreeIdentity: mixedWorktreeHostContextLabels
      })
      for (const pair of folderPairs) {
        result.push(buildFolderWorkspaceRow(pair, projectGroupDepth))
      }
    }
  }
}
