import { SessionFieldOrder } from '../../../shared/session-field-order'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { AppState } from '../store/types'
import { selectFolderWorkspaces, selectWorktreesByRepo } from '../store/workspace-record-selectors'
import {
  buildHostSessionRouting,
  type HostPersistenceState,
  type HostSessionRouting
} from './workspace-session-host-persistence'
import { normalizeWorkspaceSessionKeyToWorktreeId } from './workspace-session-host-contention'
import { groupSessionCatalog, type SessionSourceDiscovery } from './session-source-fields'

type WorktreeRows = AppState['worktreesByRepo'][string]

/** Catalog contributions select routing inputs; the existing resolver retains ownership policy. */
export class SessionRoutingCatalog {
  private state: HostPersistenceState
  private readonly repos: Map<string, AppState['repos']>
  private readonly folders: Map<string, AppState['folderWorkspaces']>
  private readonly groups: Map<string, AppState['projectGroups']>
  private readonly order = new SessionFieldOrder<'worktreesByRepo'>()
  private readonly buckets = new Map<string, WorktreeRows>()
  private readonly owners = new Map<string, Map<string, WorktreeRows>>()
  private readonly ownersByRepo = new Map<string, Set<string>>()
  private readonly foldersByGroup = new Map<string, Set<string>>()
  private readonly restored = new Map<string, Set<string>>()
  private readonly primary = new Map<string, Set<string>>()
  private readonly aliases = new Map<string, Set<string>>()
  private readonly cache = new Map<string, ExecutionHostId>()
  private readonly claims = new Map<string, ReadonlySet<ExecutionHostId>>()
  readonly routing: HostSessionRouting

  constructor(state: AppState) {
    this.state = state
    this.repos = groupSessionCatalog(state.repos)
    this.folders = groupSessionCatalog(selectFolderWorkspaces(state) ?? [])
    this.groups = groupSessionCatalog(state.projectGroups ?? [])
    for (const [id, rows] of this.folders) {
      this.indexFolder(id, rows)
    }
    for (const [bucket, rows] of Object.entries(selectWorktreesByRepo(state))) {
      this.replaceBucket(bucket, rows)
    }
    for (const key of Object.keys(state.restoredRuntimeHostIdByWorkspaceSessionKey ?? {})) {
      this.indexRestored(this.restored, key, true)
    }
    for (const key of Object.keys(state.contestedPrimaryHostBySessionKey ?? {})) {
      this.indexRestored(this.primary, key, true)
    }
    this.routing = { hostIdByWorktreeId: (owner) => this.resolve(owner), claims: this.claims }
    for (const owner of this.owners.keys()) {
      this.resolve(owner)
    }
  }

  private indexRestored(index: Map<string, Set<string>>, key: string, present: boolean): string {
    const owner = normalizeWorkspaceSessionKeyToWorktreeId(key)
    const keys = index.get(owner) ?? new Set<string>()
    if (present) {
      keys.add(key)
    } else {
      keys.delete(key)
    }
    if (keys.size) {
      index.set(owner, keys)
    } else {
      index.delete(owner)
    }
    return owner
  }

  private indexFolder(id: string, rows: AppState['folderWorkspaces']): void {
    for (const row of rows) {
      const ids = this.foldersByGroup.get(row.projectGroupId) ?? new Set<string>()
      ids.add(id)
      this.foldersByGroup.set(row.projectGroupId, ids)
    }
  }

  private replaceBucket(bucket: string, rows: WorktreeRows): Set<string> {
    this.order.write('worktreesByRepo', bucket, true)
    const changed = new Set((this.buckets.get(bucket) ?? []).map((row) => row.id))
    const grouped = groupSessionCatalog(rows)
    for (const id of grouped.keys()) {
      changed.add(id)
    }
    for (const id of changed) {
      const contributions = this.owners.get(id) ?? new Map<string, WorktreeRows>()
      for (const prior of contributions.get(bucket) ?? []) {
        this.ownersByRepo.get(prior.repoId)?.delete(id)
      }
      const next = grouped.get(id)
      if (next) {
        contributions.set(bucket, next)
      } else {
        contributions.delete(bucket)
      }
      if (contributions.size) {
        this.owners.set(id, contributions)
      } else {
        this.owners.delete(id)
      }
      for (const entries of contributions.values()) {
        for (const row of entries) {
          const owners = this.ownersByRepo.get(row.repoId) ?? new Set<string>()
          owners.add(id)
          this.ownersByRepo.set(row.repoId, owners)
        }
      }
    }
    if (rows.length) {
      this.buckets.set(bucket, rows)
    } else {
      this.buckets.delete(bucket)
    }
    return changed
  }

  repoRows(ids: Iterable<string>): AppState['repos'] {
    return [...new Set(ids)].flatMap((id) => this.repos.get(id) ?? [])
  }

  worktreeRows(ids: Iterable<string>): Record<string, WorktreeRows> {
    const selected: Record<string, WorktreeRows> = {}
    const owners = [...ids]
    const buckets = new Set(owners.flatMap((id) => [...(this.owners.get(id)?.keys() ?? [])]))
    for (const bucket of this.order.ordered('worktreesByRepo', buckets)) {
      for (const id of owners) {
        const rows = this.owners.get(id)?.get(bucket)
        if (rows) {
          ;(selected[bucket] ??= []).push(...rows)
        }
      }
    }
    return selected
  }

  private resolve(key: string): ExecutionHostId {
    const cached = this.cache.get(key)
    if (cached) {
      return cached
    }
    const owner = normalizeWorkspaceSessionKeyToWorktreeId(key)
    const aliases = this.aliases.get(owner) ?? new Set<string>()
    aliases.add(key)
    this.aliases.set(owner, aliases)
    const worktreesByRepo = this.worktreeRows([owner])
    const repoIds = new Set([getRepoIdFromWorktreeId(owner)])
    for (const rows of Object.values(worktreesByRepo)) {
      for (const row of rows) {
        repoIds.add(row.repoId)
      }
    }
    const restored = Object.fromEntries(
      [...(this.restored.get(owner) ?? [])]
        .map((alias) => [alias, this.state.restoredRuntimeHostIdByWorkspaceSessionKey?.[alias]])
        .filter(([, host]) => host !== undefined)
    )
    const primary = Object.fromEntries(
      [...(this.primary.get(owner) ?? [])]
        .map((alias) => [alias, this.state.contestedPrimaryHostBySessionKey?.[alias]])
        .filter(([, host]) => host !== undefined)
    )
    // Folder lookup is keyed; its selected group still goes through the full resolver.
    const scope = parseWorkspaceKey(key)
    const folders = [
      ...(this.folders.get(scope?.type === 'folder' ? scope.folderWorkspaceId : '') ?? [])
    ]
    const routing = buildHostSessionRouting({
      repos: this.repoRows(repoIds),
      worktreesByRepo,
      folderWorkspaces: folders,
      projectGroups: folders.flatMap((row) => this.groups.get(row.projectGroupId) ?? []),
      restoredRuntimeHostIdByWorkspaceSessionKey: restored,
      contestedPrimaryHostBySessionKey: primary
    })
    const claims = routing.claims.get(owner)
    if (claims) {
      this.claims.set(owner, claims)
    } else {
      this.claims.delete(owner)
    }
    const host = routing.hostIdByWorktreeId(key)
    for (const repo of repoIds) {
      const owners = this.ownersByRepo.get(repo) ?? new Set<string>()
      owners.add(owner)
      this.ownersByRepo.set(repo, owners)
    }
    this.cache.set(key, host)
    return host
  }

  update(state: AppState, discovery: SessionSourceDiscovery): ReadonlySet<string> {
    const changed = new Set<string>()
    for (const id of discovery.changes.get('repos') ?? []) {
      const rows = discovery.sequences?.repos?.get(id)
      if (rows) {
        this.repos.set(id, rows)
      } else {
        this.repos.delete(id)
      }
      for (const owner of this.ownersByRepo.get(id) ?? []) {
        changed.add(owner)
      }
    }
    for (const bucket of discovery.changes.get('worktreesByRepo') ?? []) {
      for (const owner of this.replaceBucket(bucket, selectWorktreesByRepo(state)[bucket] ?? [])) {
        changed.add(owner)
      }
      if (!Object.hasOwn(selectWorktreesByRepo(state), bucket)) {
        this.order.write('worktreesByRepo', bucket, false)
      }
    }
    for (const id of discovery.changes.get('folderWorkspaces') ?? []) {
      for (const row of this.folders.get(id) ?? []) {
        this.foldersByGroup.get(row.projectGroupId)?.delete(id)
      }
      const rows = discovery.sequences?.['folderWorkspaces']?.get(id)
      if (rows) {
        this.folders.set(id, rows)
      } else {
        this.folders.delete(id)
      }
      this.indexFolder(id, rows ?? [])
      changed.add(folderWorkspaceKey(id))
    }
    for (const id of discovery.changes.get('projectGroups') ?? []) {
      const rows = discovery.sequences?.projectGroups?.get(id)
      if (rows) {
        this.groups.set(id, rows)
      } else {
        this.groups.delete(id)
      }
      for (const folder of this.foldersByGroup.get(id) ?? []) {
        changed.add(folderWorkspaceKey(folder))
      }
    }
    for (const [field, index] of [
      ['restoredRuntimeHostIdByWorkspaceSessionKey', this.restored],
      ['contestedPrimaryHostBySessionKey', this.primary]
    ] as const) {
      for (const key of discovery.changes.get(field) ?? []) {
        changed.add(this.indexRestored(index, key, Object.hasOwn(state[field] ?? {}, key)))
      }
    }
    this.state = state
    for (const owner of changed) {
      this.cache.delete(owner)
      for (const alias of this.aliases.get(owner) ?? []) {
        this.cache.delete(alias)
      }
      for (const alias of this.restored.get(owner) ?? []) {
        this.cache.delete(alias)
      }
      for (const alias of this.primary.get(owner) ?? []) {
        this.cache.delete(alias)
      }
      this.resolve(owner)
    }
    return changed
  }
}
