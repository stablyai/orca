import type { GlobalSettings } from './global-settings-types'
import type { PersistedState } from './persisted-state-types'
import type { Project, ProjectHostSetup } from './project-types'
import type { Worktree } from './worktree/types'
import type { WorktreeLineageWarning, WorkspaceLineage } from './worktree/lineage-types'
import { parseWorkspaceKey, worktreeWorkspaceKey, type WorkspaceKey } from './workspace-scope'
import { getRepoExecutionHostId } from './execution-host'
import {
  getExecutionHostIdFromWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from './worktree/host-qualified-identity'
import { splitWorktreeId } from './worktree/id'
import { toWorkspaceLineageRow } from './worktree/worktree-lineage-workspace-row'

export type WorkspaceLineagePolicy = 'any-project' | 'same-project'
export type LineageProjectCatalog = {
  projects: readonly Project[]
  projectHostSetups: readonly ProjectHostSetup[]
}

export function getWorkspaceLineagePolicy(
  settings: Pick<GlobalSettings, 'workspaceLineagePolicy'> | null | undefined
): WorkspaceLineagePolicy {
  return settings?.workspaceLineagePolicy === 'same-project' ? 'same-project' : 'any-project'
}

export function confirmedRepoLineageProject(
  catalog: LineageProjectCatalog,
  repoId: string,
  hostId: string | undefined
): string | undefined {
  if (!hostId) {
    return undefined
  }
  const projects = new Set(
    catalog.projectHostSetups
      .filter((setup) => setup.repoId === repoId && setup.hostId === hostId)
      .map((setup) => setup.projectId)
  )
  if (projects.size !== 1) {
    return undefined
  }
  const projectId = [...projects][0]
  return catalog.projects.some((project) => project.id === projectId) ? projectId : undefined
}

export function confirmedWorktreeLineageProject(
  catalog: LineageProjectCatalog,
  row: Pick<Worktree, 'repoId' | 'projectId' | 'hostId' | 'projectHostSetupId' | 'instanceId'>
): string | undefined {
  const projectId = confirmedRepoLineageProject(catalog, row.repoId, row.hostId)
  if (!row.instanceId || !projectId || row.projectId !== projectId) {
    return undefined
  }
  if (
    row.projectHostSetupId &&
    !catalog.projectHostSetups.some(
      (setup) =>
        setup.id === row.projectHostSetupId &&
        setup.repoId === row.repoId &&
        setup.hostId === row.hostId &&
        setup.projectId === projectId
    )
  ) {
    return undefined
  }
  return projectId
}

export class WorkspaceLineagePolicyError extends Error {
  constructor(
    readonly code: 'LINEAGE_PARENT_CONTEXT_CONFLICT' | 'LINEAGE_PARENT_CYCLE',
    message: string
  ) {
    super(message)
  }
}

export const PROJECT_LINEAGE_CONFLICT_MESSAGE =
  'Parent and child must have the same confirmed project identity. Choose a parent in this project, or use --no-parent.'

type LineageState = Pick<
  PersistedState,
  | 'settings'
  | 'repos'
  | 'projects'
  | 'projectHostSetups'
  | 'worktreeMeta'
  | 'worktreeMetaByIdentity'
  | 'worktreeIdentityAliases'
  | 'worktreeLineageById'
  | 'workspaceLineageByChildKey'
  | 'crossStoreLineageByChildKey'
>
type Endpoint = { projectId: string | undefined; hostId: string }

export function createLineageProjectLookup(
  state: LineageState
): (
  key: WorkspaceKey,
  instanceId: string | null | undefined,
  hostId?: string
) => Endpoint | undefined {
  const endpoints = new Map<string, Endpoint[]>()
  const projectIds = new Set(state.projects.map((project) => project.id))
  const setups = new Map<string, { projectIds: Set<string>; setupIds: Set<string> }>()
  for (const setup of state.projectHostSetups) {
    const key = `${setup.repoId}\0${setup.hostId}`
    const entry = setups.get(key) ?? { projectIds: new Set<string>(), setupIds: new Set<string>() }
    entry.projectIds.add(setup.projectId)
    entry.setupIds.add(setup.id)
    setups.set(key, entry)
  }
  const repoHosts = new Map<string, Set<string>>()
  for (const repo of state.repos) {
    const hosts = repoHosts.get(repo.id) ?? new Set<string>()
    hosts.add(getRepoExecutionHostId(repo))
    repoHosts.set(repo.id, hosts)
  }
  const add = (id: string, meta: PersistedState['worktreeMeta'][string], aliasHost?: string) => {
    const repoId = splitWorktreeId(id)?.repoId
    if (!repoId || !meta.instanceId || (aliasHost && meta.hostId && aliasHost !== meta.hostId)) {
      return
    }
    const hosts = repoHosts.get(repoId)
    const hostId = meta.hostId ?? aliasHost ?? (hosts?.size === 1 ? [...hosts][0] : undefined)
    if (!hostId) {
      return
    }
    const setup = setups.get(`${repoId}\0${hostId}`)
    const projectId =
      meta.projectId &&
      projectIds.has(meta.projectId) &&
      setup?.projectIds.size === 1 &&
      setup.projectIds.has(meta.projectId) &&
      (!meta.projectHostSetupId || setup.setupIds.has(meta.projectHostSetupId))
        ? meta.projectId
        : undefined
    const key = `${worktreeWorkspaceKey(id)}\0${meta.instanceId}`
    const rows = endpoints.get(key) ?? []
    if (!rows.some((row) => row.hostId === hostId && row.projectId === projectId)) {
      rows.push({ projectId, hostId })
    }
    endpoints.set(key, rows)
  }
  for (const [id, meta] of Object.entries(state.worktreeMeta)) {
    add(id, meta)
  }
  for (const [alias, keys] of Object.entries(state.worktreeIdentityAliases ?? {})) {
    const id = getWorktreeIdFromHostIdentity(alias)
    if (!id) {
      continue
    }
    for (const key of keys) {
      const meta = state.worktreeMetaByIdentity?.[key]
      if (meta) {
        add(id, meta, getExecutionHostIdFromWorktreeHostIdentity(alias))
      }
    }
  }
  return (key, instanceId, hostId) => {
    if (!instanceId) {
      return undefined
    }
    const rows = (endpoints.get(`${key}\0${instanceId}`) ?? []).filter(
      (row) => !hostId || row.hostId === hostId
    )
    return rows.length === 1 ? rows[0] : undefined
  }
}

export function projectLineageAllowed(
  state: LineageState,
  edge: WorkspaceLineage,
  lookup?: ReturnType<typeof createLineageProjectLookup>
): boolean {
  if (getWorkspaceLineagePolicy(state.settings) !== 'same-project') {
    return true
  }
  const read = lookup ?? createLineageProjectLookup(state)
  const child = read(edge.childWorkspaceKey, edge.childInstanceId)
  const parent = read(edge.parentWorkspaceKey, edge.parentInstanceId)
  return Boolean(child?.projectId && parent?.projectId && child.projectId === parent.projectId)
}

/** Mutation validation reads saved edges, never the project-filtered consumer graph. */
export function assertPersistedLineageAcyclic(
  state: LineageState,
  edge: WorkspaceLineage,
  hostId: string
): void {
  const lookup = createLineageProjectLookup(state)
  const visited = new Set<WorkspaceKey>()
  let key = edge.parentWorkspaceKey
  let instanceId = edge.parentInstanceId
  while (!visited.has(key)) {
    if (key === edge.childWorkspaceKey && instanceId === edge.childInstanceId) {
      throw new WorkspaceLineagePolicyError(
        'LINEAGE_PARENT_CYCLE',
        'Parent selector would create a lineage cycle.'
      )
    }
    visited.add(key)
    if (!lookup(key, instanceId, hostId)) {
      break
    }
    const scope = parseWorkspaceKey(key)
    const saved =
      scope?.type === 'worktree' ? state.worktreeLineageById[scope.worktreeId] : undefined
    const next = saved ? toWorkspaceLineageRow(saved) : state.workspaceLineageByChildKey[key]
    if (
      !next ||
      next.childInstanceId !== instanceId ||
      !lookup(next.parentWorkspaceKey, next.parentInstanceId, hostId)
    ) {
      break
    }
    key = next.parentWorkspaceKey
    instanceId = next.parentInstanceId
  }
}

export function admitPersistedLineageWrite(
  state: LineageState,
  edge: WorkspaceLineage,
  hostId?: string
): boolean {
  if (getWorkspaceLineagePolicy(state.settings) !== 'same-project') {
    return true
  }
  const scope = parseWorkspaceKey(edge.childWorkspaceKey)
  const legacy =
    scope?.type === 'worktree' ? state.worktreeLineageById[scope.worktreeId] : undefined
  const saved = legacy
    ? toWorkspaceLineageRow(legacy)
    : state.workspaceLineageByChildKey[edge.childWorkspaceKey]
  if (
    edge.capture.confidence === 'inferred' &&
    (state.crossStoreLineageByChildKey?.[edge.childWorkspaceKey] ||
      (saved && !projectLineageAllowed(state, saved)))
  ) {
    return false
  }
  if (!projectLineageAllowed(state, edge)) {
    if (edge.capture.confidence === 'inferred') {
      return false
    }
    throw new WorkspaceLineagePolicyError(
      'LINEAGE_PARENT_CONTEXT_CONFLICT',
      PROJECT_LINEAGE_CONFLICT_MESSAGE
    )
  }
  const owner =
    hostId ??
    createLineageProjectLookup(state)(edge.childWorkspaceKey, edge.childInstanceId)?.hostId
  if (owner) {
    assertPersistedLineageAcyclic(state, edge, owner)
  }
  return true
}

export function appendLineageDiagnosticComment(
  comment: string | undefined,
  resolution: { kind: string; warnings?: readonly WorktreeLineageWarning[] }
): string | undefined {
  if (resolution.kind !== 'none' || !resolution.warnings?.length) {
    return comment
  }
  const diagnostics = resolution.warnings
    .map((warning) => {
      const details = warning.details ?? {}
      const references = [
        'parentWorkspaceKey',
        'parentInstallationId',
        'taskId',
        'orchestrationRunId',
        'coordinatorHandle',
        'createdByTerminalHandle'
      ].flatMap((key) => (typeof details[key] === 'string' ? [`${key}=${details[key]}`] : []))
      return `${warning.message}${references.length ? ` (${references.join(', ')})` : ''}`
    })
    .join('\n')
  if (comment?.endsWith(diagnostics)) {
    return comment
  }
  return comment ? `${comment}\n\n${diagnostics}` : diagnostics
}
