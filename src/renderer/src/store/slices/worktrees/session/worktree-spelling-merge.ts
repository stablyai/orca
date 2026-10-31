import { editWorkspacePresentationDocuments } from '../../../../../../shared/workspace-presentation-documents'
import { getOpenFileExecutionHostId } from '@/lib/unified-tab-host-ownership'
import type { AppState } from '../../../types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getRepoIdFromWorktreeId } from '../../../../../../shared/worktree/id'
import {
  strictWorktreeIdentityKey,
  sourceBaseline,
  workspacePresentationKey,
  type WorkspacePresentation
} from '../../../../../../shared/workspace-presentation'
import { settleWorkspacePresentation } from '../../../../../../shared/workspace-presentation-settlement'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'
import {
  noteWorkspacePresentationChanges,
  documentChanges,
  rawWorkspaceState,
  workspaceSourceSession
} from '../../../workspace-composition'
import { isExecutionHostAliasForWorktree } from '@/lib/worktree-execution-host-alias'
import { migrateHugeRepoWarningDismissal } from '@/lib/source-control-huge-repo-warning-dismissals'
import { migrateHostedReviewLinkMutationGeneration } from '../metadata/hosted-review-link-mutation'

let indexedStore: AppState['fetchWorktrees'] | undefined
let previousInputs: unknown[] = []
let fileHostsByWorkspace = new Map<string, Set<ExecutionHostId>>()
let indexedFiles: AppState['openFiles'] | undefined
const catalogIndexes = new WeakMap<
  readonly Worktree[],
  { byId: Map<string, Worktree[]>; byIdentity: Map<string, Worktree[]> }
>()
function catalogIndex(rows: readonly Worktree[]) {
  let index = catalogIndexes.get(rows)
  if (!index) {
    index = { byId: new Map(), byIdentity: new Map() }
    for (const row of rows) {
      for (const [map, key] of [
        [index.byId, row.id],
        [index.byIdentity, strictWorktreeIdentityKey(row.id)]
      ] as const) {
        const records = map.get(key) ?? []
        records.push(row)
        map.set(key, records)
      }
    }
    catalogIndexes.set(rows, index)
  }
  return index
}
const noRows: readonly Worktree[] = []
let ownersByRepo = new Map<string, Map<string, string[]>>()

/** Index source owners once per changed input, reused by every repo in a listing batch. */
function sourceOwners(
  state: AppState,
  changedSources?: readonly string[]
): Map<string, Map<string, string[]>> {
  if (indexedStore !== state.fetchWorktrees) {
    indexedStore = state.fetchWorktrees
    previousInputs = []
    indexedFiles = undefined
    fileHostsByWorkspace = new Map()
  }
  const inputs = [
    state.unifiedTabsByWorktree,
    state.tabsByWorktree,
    state.browserTabsByWorktree,
    state.openFiles
  ]
  if (inputs.every((value, index) => value === previousInputs[index])) {
    return ownersByRepo
  }
  const incremental =
    changedSources && previousInputs.length > 0 && indexedFiles === state.openFiles
  previousInputs = inputs
  if (!incremental) {
    ownersByRepo = new Map()
  }
  const ids = incremental
    ? new Set(changedSources)
    : new Set([
        ...Object.keys(state.unifiedTabsByWorktree),
        ...Object.keys(state.tabsByWorktree),
        ...Object.keys(state.browserTabsByWorktree),
        ...state.openFiles.map((file) => file.worktreeId)
      ])
  for (const id of ids) {
    const repo = getRepoIdFromWorktreeId(id)
    const byIdentity = ownersByRepo.get(repo) ?? new Map<string, string[]>()
    const identity = strictWorktreeIdentityKey(id)
    const sources = byIdentity.get(identity) ?? []
    if (
      incremental &&
      !Object.hasOwn(state.unifiedTabsByWorktree, id) &&
      !Object.hasOwn(state.tabsByWorktree, id) &&
      !Object.hasOwn(state.browserTabsByWorktree, id) &&
      !fileHostsByWorkspace.has(id)
    ) {
      const remaining = sources.filter((source) => source !== id)
      if (remaining.length) {
        byIdentity.set(identity, remaining)
      } else {
        byIdentity.delete(identity)
      }
      if (!byIdentity.size) {
        ownersByRepo.delete(repo)
      }
      continue
    }
    if (!sources.includes(id)) {
      sources.push(id)
    }
    byIdentity.set(identity, sources)
    ownersByRepo.set(repo, byIdentity)
  }
  return ownersByRepo
}

/** Discovery changes a view binding, never the source's membership, command address or cursor. */
export function mergeListedWorktreeSpellings(
  view: AppState,
  repoId: string,
  hostId: ExecutionHostId,
  detected: { worktrees: readonly Worktree[] }
): Partial<AppState> {
  const state = rawWorkspaceState(view)
  const byIdentity = sourceOwners(state).get(repoId)
  if (!byIdentity) {
    return {}
  }
  if (indexedFiles !== state.openFiles) {
    indexedFiles = state.openFiles
    fileHostsByWorkspace = new Map()
    for (const file of state.openFiles) {
      const executionHostId = getOpenFileExecutionHostId(file)
      if (executionHostId) {
        const hosts = fileHostsByWorkspace.get(file.worktreeId) ?? new Set<ExecutionHostId>()
        hosts.add(executionHostId)
        fileHostsByWorkspace.set(file.worktreeId, hosts)
      }
    }
  }
  const session = workspaceSourceSession(state)
  const owner = ORCA_LAYOUT_OWNER_IS_MAIN ? 'main' : 'window'
  let documents = state.workspacePresentations ?? {}
  const changed: string[] = []
  for (const listed of detected.worktrees) {
    const ids = byIdentity.get(strictWorktreeIdentityKey(listed.id)) ?? []
    if (!ids.some((id) => id !== listed.id)) {
      continue
    }
    const knownRowsById = catalogIndex(state.worktreesByRepo[repoId] ?? noRows).byId
    const compatible = ids.filter((id) => {
      const restored =
        state.contestedPrimaryHostBySessionKey?.[id] ??
        state.restoredRuntimeHostIdByWorkspaceSessionKey?.[id]
      if (restored && !isExecutionHostAliasForWorktree(restored, listed)) {
        return false
      }
      const knownRows = knownRowsById.get(id) ?? []
      if (knownRows.some((row) => row.id === id && !isExecutionHostAliasForWorktree(hostId, row))) {
        return false
      }
      if (
        [...(fileHostsByWorkspace.get(id) ?? [])].some(
          (owner) => !isExecutionHostAliasForWorktree(owner, listed)
        )
      ) {
        return false
      }
      const tabs = state.unifiedTabsByWorktree[id] ?? []
      if (
        tabs.some(
          (tab) =>
            tab.executionHostId && !isExecutionHostAliasForWorktree(tab.executionHostId, listed)
        )
      ) {
        return false
      }
      return isExecutionHostAliasForWorktree(hostId, listed)
    })
    if (!compatible.some((id) => id !== listed.id)) {
      continue
    }
    const anchor = { hostId, executionHostId: listed.hostId ?? hostId, workspaceId: listed.id }
    const key = workspacePresentationKey(owner, anchor)
    const existing = documents[key]
    const sourceIds = [
      ...new Set([
        ...(existing?.baseline.map(({ source }) => source.workspaceId) ?? []),
        ...compatible,
        listed.id
      ])
    ]
    const baseline = sourceIds.map((workspaceId) =>
      sourceBaseline(session, { hostId, executionHostId: listed.hostId ?? hostId, workspaceId })
    )
    let saved = existing
    if (!saved) {
      // A cache row has no geometry. Prefer a genuine destination, otherwise retain the source whole.
      const preferred =
        baseline.find((entry) => entry.source.workspaceId === listed.id && entry.tabs.length) ??
        baseline.find((entry) => entry.tabs.length)
      if (!preferred) {
        continue
      }
      saved = {
        schemaVersion: 1,
        owner,
        anchor,
        displayWorkspaceId: listed.id,
        tabs: preferred.tabs,
        groups: preferred.groups.map((group) => ({ ...group, worktreeId: listed.id })),
        layout: preferred.layout,
        activeGroupId: preferred.activeGroupId,
        baseline: []
      }
    }
    const next: WorkspacePresentation = settleWorkspacePresentation(
      saved.displayWorkspaceId === listed.id ? saved : { ...saved, displayWorkspaceId: listed.id },
      baseline
    )
    if (existing === next) {
      continue
    }
    documents = editWorkspacePresentationDocuments(documents, key, next)
    changed.push(key)
    if (!existing || existing.displayWorkspaceId !== listed.id) {
      for (const id of compatible) {
        if (id !== listed.id) {
          migrateHugeRepoWarningDismissal(id, listed.id)
          migrateHostedReviewLinkMutationGeneration(id, listed.id)
        }
      }
    }
  }
  if (changed.length) {
    noteWorkspacePresentationChanges(documents, changed)
  }
  return changed.length ? { workspacePresentations: documents } : {}
}

/** A newly admitted source uses the current positive catalog observation without waiting for a relist. */
export function discoverWorkspacePresentations(
  state: AppState,
  changedSources: readonly string[]
): Partial<AppState> {
  sourceOwners(state, changedSources)
  let next = state
  const changed = new Set<string>()
  const repos = new Map<string, Set<string>>()
  for (const id of changedSources) {
    const repo = getRepoIdFromWorktreeId(id)
    const identities = repos.get(repo) ?? new Set<string>()
    identities.add(strictWorktreeIdentityKey(id))
    repos.set(repo, identities)
  }
  for (const [repoId, identities] of repos) {
    const rows = catalogIndex(state.worktreesByRepo[repoId] ?? noRows).byIdentity
    for (const row of [...identities].flatMap((identity) => rows.get(identity) ?? [])) {
      const hostId: ExecutionHostId = row.runtimeOwnerEnvironmentId
        ? `runtime:${row.runtimeOwnerEnvironmentId}`
        : (row.hostId ?? 'local')
      const patch = mergeListedWorktreeSpellings(next, repoId, hostId, { worktrees: [row] })
      if (
        patch.workspacePresentations &&
        patch.workspacePresentations !== next.workspacePresentations
      ) {
        for (const key of documentChanges.get(patch.workspacePresentations) ?? []) {
          changed.add(key)
        }
        next = { ...next, ...patch }
      }
    }
  }
  if (next.workspacePresentations && changed.size) {
    noteWorkspacePresentationChanges(next.workspacePresentations, [...changed])
  }
  return next === state ? {} : { workspacePresentations: next.workspacePresentations }
}
