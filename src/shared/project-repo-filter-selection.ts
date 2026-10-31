import {
  getRepoExecutionHostId,
  getRepoSshConnectionId,
  toSshExecutionHostId,
  type ExecutionHostId
} from './execution-host'
import type { ProjectGroupingIndex, ProjectSectionSetup } from './project-section-grouping'
import { projectRepoFilterMatcher } from './project-grouping'

/** The row's filesystem, separately from the endpoint that transports its catalog. */
export function getProjectRepoFilterHost(
  source: Partial<Pick<ProjectSectionSetup, 'hostId' | 'executionHostId' | 'connectionId'>>
): ExecutionHostId {
  const location = {
    executionHostId: source.executionHostId ?? source.hostId,
    connectionId: source.connectionId
  }
  const connection = getRepoSshConnectionId(location)
  return connection ? toSshExecutionHostId(connection) : getRepoExecutionHostId(location)
}

export type ProjectFilterSelection = {
  active: boolean
  fullKeys: string[]
  partialKeys: string[]
  matchingKeys: string[]
  full: ReadonlySet<string>
  partial: ReadonlySet<string>
  matching: ReadonlySet<string>
  unresolved: string[]
  badgeCount: number
}

const selections = new WeakMap<
  ProjectGroupingIndex,
  WeakMap<readonly string[], ProjectFilterSelection>
>()

export function projectFilterSelection(
  index: ProjectGroupingIndex,
  ids: readonly string[]
): ProjectFilterSelection {
  let cache = selections.get(index)
  if (!cache) {
    cache = new WeakMap()
    selections.set(index, cache)
  }
  const cached = cache.get(ids)
  if (cached) {
    return cached
  }
  const matches = projectRepoFilterMatcher(ids)
  const fullKeys: string[] = []
  const partialKeys: string[] = []
  const matchingKeys: string[] = []
  const known = new Set<string>()
  const knownRepoIds = new Set<string>()
  for (const group of index.groups) {
    let count = 0
    for (const setup of group.registrations) {
      const host = getProjectRepoFilterHost(setup)
      known.add(`${host}\0${setup.repoId}`)
      knownRepoIds.add(setup.repoId)
      if (ids.length && matches(setup.repoId, host)) {
        count++
      }
    }
    if (!count) {
      continue
    }
    matchingKeys.push(group.key)
    ;(count === group.registrations.length ? fullKeys : partialKeys).push(group.key)
  }
  const unresolved = ids.filter((id) =>
    id.includes('\0') ? !known.has(id) : !knownRepoIds.has(id)
  )
  const result = {
    active: ids.length > 0,
    fullKeys,
    partialKeys,
    matchingKeys,
    full: new Set(fullKeys),
    partial: new Set(partialKeys),
    matching: new Set(matchingKeys),
    unresolved,
    badgeCount: ids.length ? Math.max(1, matchingKeys.length) : 0
  }
  cache.set(ids, result)
  return result
}

export function editProjectFilter(
  index: ProjectGroupingIndex,
  previous: readonly string[],
  intent: { kind: 'clear' } | { kind: 'complete' | 'remove'; keys: readonly string[] }
): string[] {
  if (intent.kind === 'clear') {
    return []
  }
  const touched = new Set<string>()
  const touchedRepoIds = new Set<string>()
  for (const key of intent.keys) {
    for (const setup of index.groupByKey.get(key)?.registrations ?? []) {
      touched.add(`${getProjectRepoFilterHost(setup)}\0${setup.repoId}`)
      touchedRepoIds.add(setup.repoId)
    }
  }
  const matches = projectRepoFilterMatcher(previous)
  const result = previous.filter((id) =>
    id.includes('\0') ? !touched.has(id) : !touchedRepoIds.has(id)
  )
  const retainedByRepo = new Map<string, string[]>()
  const totalByRepo = new Map<string, number>()
  const registrations = new Map<string, { repoId: string; hostId: string }>()
  for (const group of index.groups) {
    for (const setup of group.registrations) {
      const hostId = getProjectRepoFilterHost(setup)
      registrations.set(`${hostId}\0${setup.repoId}`, { repoId: setup.repoId, hostId })
    }
  }
  for (const [identity, setup] of registrations) {
    if (!touchedRepoIds.has(setup.repoId)) {
      continue
    }
    totalByRepo.set(setup.repoId, (totalByRepo.get(setup.repoId) ?? 0) + 1)
    if (
      touched.has(identity)
        ? intent.kind === 'complete'
        : previous.length > 0 && matches(setup.repoId, setup.hostId)
    ) {
      const selected = retainedByRepo.get(setup.repoId) ?? []
      selected.push(identity)
      retainedByRepo.set(setup.repoId, selected)
    }
  }
  for (const [repoId, identities] of retainedByRepo) {
    result.push(...(identities.length === totalByRepo.get(repoId) ? [repoId] : identities))
  }
  return [...new Set(result)]
}
