/* eslint-disable max-lines -- Binding disposal, write settlement, canonical reads and Project projection share one accepted record and ownership lane. */
import { deleteConfirmedListSnapshot } from '@/components/task-page/github/task-page-github-work-item-mutation-registry'
import { deleteLastConfirmedClientValue } from '@/components/task-page/github/task-page-github-confirmed-client-values'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { Repo } from '../../../../shared/repo-types'
import type { AppState } from '../types'
import type { StoreApi } from 'zustand'
import {
  captureGitHubTaskObservation,
  githubTaskBinding,
  type GitHubTaskObservation
} from '@/lib/github-task-observation'
import { githubTaskIdentity } from '@/lib/github-task-target'
import { lookupGitHubWorkItemByOwnerRepoForSource } from '@/lib/github-work-item-source-lookup'
import { getWorkItemRepo } from '@/lib/work-item-repo-row'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { parseGitHubIssueOrPRLink } from '../../../../shared/github/links'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { structuralValuesEqual } from '../../../../shared/structural-value-equality'
import { nextProviderRequestId } from './request-coordination'
import { projectViewSourceScope } from './cache-identity'
import { isHostIdentityFenceCurrent } from '../host-catalog-fencing'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'
import { patchGitHubProjectRowContent } from './project-row-actions'
import type { GitHubProjectRow, GitHubProjectTable } from '../../../../shared/github/project-types'

export type TaskDelta = (base: GitHubWorkItem) => GitHubWorkItem
export type TaskBinding = { observation: GitHubTaskObservation; incarnation: object }
type AcceptedTask = {
  binding: TaskBinding
  base: GitHubWorkItem
  visible: GitHubWorkItem
  pending: Map<object, TaskDelta>
  revision: number
  readOrder: number
  needsRead: boolean
  read?: { revision: number; light: boolean; promise: Promise<boolean> }
}
// Project rows carry the first 10 labels and 5 assignees (project-view-query-fragments.ts).
const PROJECT_LABEL_LIMIT = 10
const PROJECT_ASSIGNEE_LIMIT = 5
const version = (item: GitHubWorkItem) => Date.parse(item.updatedAt)
const login = (value: string) => value.toLowerCase()
const sorted = (values: readonly string[]) => [...values].sort().join('\0')
const logins = (item: GitHubWorkItem) => item.assignees?.map((user) => login(user.login))
const bindingKey = (repo: Repo) => `${getRepoExecutionHostId(repo)}\0${repo.id}`

/** Records own state, label-name and assignee-login membership; profiles and presentation follow the latest row. */
function sameFacts(a: GitHubWorkItem, b: GitHubWorkItem, unknownAssigneesMatch = true): boolean {
  const left = logins(a),
    right = logins(b)
  return (
    a.title === b.title &&
    a.state === b.state &&
    sorted(a.labels) === sorted(b.labels) &&
    (left && right ? sorted(left) === sorted(right) : unknownAssigneesMatch || left === right)
  )
}
function facts(item: GitHubWorkItem): Partial<GitHubWorkItem> {
  const { title, state, labels, assignees } = item
  return { title, state, labels, ...(assignees === undefined ? {} : { assignees }) }
}
function withFacts(row: GitHubWorkItem, visible: GitHubWorkItem): GitHubWorkItem {
  const users = new Map(row.assignees?.map((user) => [login(user.login), user]))
  return {
    ...row,
    ...facts(visible),
    ...(visible.assignees === undefined
      ? {}
      : { assignees: visible.assignees.map((user) => users.get(login(user.login)) ?? user) }),
    ...(version(visible) > version(row) ? { updatedAt: visible.updatedAt } : {})
  }
}
/** A full-length Project list may be truncated, so only a name it carries that the record lacks conflicts. */
function projectListConflicts(partial: string[], full: string[], limit: number) {
  const known = new Set(full)
  return (
    partial.some((name) => !known.has(name)) ||
    (partial.length < limit && partial.length !== known.size)
  )
}
function projectList(partial: string[], full: string[], limit: number, norm = (v: string) => v) {
  const has = (list: string[], value: string) => list.some((entry) => norm(entry) === norm(value))
  const kept = partial.filter((name) => has(full, name))
  return partial.length < limit ? [...kept, ...full.filter((name) => !has(partial, name))] : kept
}
function newestFirst(a: AcceptedTask, b: AcceptedTask) {
  if (
    b.revision !== a.revision &&
    (a.needsRead || a.pending.size || b.needsRead || b.pending.size)
  ) {
    return b.revision - a.revision
  }
  const av = version(a.base),
    bv = version(b.base)
  return (Number.isFinite(av) && Number.isFinite(bv) ? bv - av : 0) || b.readOrder - a.readOrder
}

export class GitHubTaskRecordCache {
  private bindings = new Map<string, { signature: string; incarnation: object; id: number }>()
  private records = new Map<string, AcceptedTask>()
  private listeners = new Set<() => void>()
  private projections = new WeakMap<
    GitHubWorkItem,
    { visible: GitHubWorkItem; value: GitHubWorkItem }
  >()
  private revision = 0
  private unsupported = new WeakSet<object>()
  constructor(private store: Pick<StoreApi<AppState>, 'getState'>) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  snapshot = () => this.revision
  /** A changed account/source binding gets a fresh incarnation even when its string later repeats (A→B→A). */
  syncBindings(repos: readonly Repo[]) {
    const live = new Set<string>()
    for (const repo of repos) {
      const key = bindingKey(repo)
      const signature = githubTaskBinding(repo)
      live.add(key)
      if (this.bindings.get(key)?.signature !== signature) {
        this.bindings.set(key, { signature, incarnation: {}, id: nextProviderRequestId() })
      }
    }
    for (const key of this.bindings.keys()) {
      if (!live.has(key)) {
        this.bindings.delete(key)
      }
    }
    let changed = false
    for (const [key, record] of this.records) {
      if (!this.current(record.binding)) {
        this.records.delete(key)
        changed = true
      }
    }
    if (changed) {
      this.notify()
    }
  }
  capture(repo: Repo | undefined, source?: TaskSourceContext | null): TaskBinding | undefined {
    const entry = repo && this.bindings.get(bindingKey(repo))
    const observation =
      repo && entry?.signature === githubTaskBinding(repo)
        ? captureGitHubTaskObservation(repo, source)
        : undefined
    return entry && observation ? { observation, incarnation: entry.incarnation } : undefined
  }
  current(binding: TaskBinding): boolean {
    const { hostId, repoId, fence } = binding.observation
    return (
      this.bindings.get(`${hostId}\0${repoId}`)?.incarnation === binding.incarnation &&
      isHostIdentityFenceCurrent(fence)
    )
  }
  bindingIdentity(binding: TaskBinding) {
    const { hostId, repoId } = binding.observation
    return this.bindings.get(`${hostId}\0${repoId}`)?.id ?? 0
  }
  private key(item: GitHubWorkItem, hostId: string) {
    return `${hostId}\0${item.repoId}\0${githubTaskIdentity(item)}`
  }
  private record(item: GitHubWorkItem, binding: TaskBinding) {
    const key = this.key(item, binding.observation.hostId)
    const record = this.records.get(key)
    if (record && !this.current(record.binding)) {
      // A record whose own fence went stale dies here, whichever store field moved.
      this.records.delete(key)
      return undefined
    }
    return record?.binding.incarnation === binding.incarnation && this.current(binding)
      ? record
      : undefined
  }
  private remember(item: GitHubWorkItem, binding: TaskBinding) {
    let record = this.record(item, binding)
    if (!record) {
      record = {
        binding,
        base: item,
        visible: item,
        pending: new Map(),
        revision: 0,
        readOrder: 0,
        needsRead: false
      }
      this.records.set(this.key(item, binding.observation.hostId), record)
    }
    return record
  }
  private emit(record: AcceptedTask) {
    let visible = record.base
    for (const delta of record.pending.values()) {
      visible = delta(visible)
    }
    const changed = !sameFacts(visible, record.visible, false)
    record.visible = visible
    const { associations, hostId } = record.binding.observation
    const scopes: (string | null)[] = associations.map((association) => association.scope)
    if (hostId === 'local') {
      scopes.push(null)
    }
    // The record supersedes the older confirmed-value holds for these families.
    for (const scope of scopes) {
      deleteLastConfirmedClientValue(scope, visible.repoId, visible.id, 'state')
      deleteConfirmedListSnapshot(scope, visible.repoId, visible.id, 'assignees')
    }
    if (changed) {
      this.publish(visible, record.binding.observation)
    }
    this.notify()
  }
  private publish(value: GitHubWorkItem, observation: GitHubTaskObservation) {
    const ownerRepo = parseGitHubIssueOrPRLink(value.url)?.slug
    for (const { source } of observation.associations) {
      this.store.getState().patchWorkItem(value.id, facts(value), value.repoId, {
        sourceContext: source,
        ownerRepo
      })
    }
  }
  private notify() {
    this.revision++
    for (const listener of this.listeners) {
      listener()
    }
  }
  private projectWith(row: GitHubWorkItem, record: AcceptedTask): GitHubWorkItem {
    const visible = record.visible
    if (
      sameFacts(row, visible) &&
      (row.assignees !== undefined || visible.assignees === undefined)
    ) {
      return row
    }
    const previous = this.projections.get(row)
    if (previous?.visible === visible) {
      return previous.value
    }
    const value = withFacts(row, visible)
    this.projections.set(row, { visible, value })
    return value
  }
  /** Rows are never filtered; a current record for the row's own repo binding overlays its facts. */
  projectItem(row: GitHubWorkItem): GitHubWorkItem {
    if (!this.records.size || row.type !== 'issue') {
      return row
    }
    const repo = row.repoHostId
      ? undefined
      : getWorkItemRepo(this.store.getState().repos ?? [], row)
    const hostId = row.repoHostId ?? (repo && getRepoExecutionHostId(repo))
    const record = hostId && this.records.get(this.key(row, hostId))
    return record && this.current(record.binding) ? this.projectWith(row, record) : row
  }
  projectItems(rows: readonly GitHubWorkItem[]): readonly GitHubWorkItem[] {
    const projected = rows.map((row) => this.projectItem(row))
    return projected.every((row, index) => row === rows[index]) ? rows : projected
  }
  acceptSearch(
    rows: readonly GitHubWorkItem[],
    binding: TaskBinding | undefined
  ): readonly GitHubWorkItem[] {
    return rows.map((item) => {
      const record = binding && this.record(item, binding)
      if (!record) {
        return item
      }
      if (
        !record.needsRead &&
        !record.pending.size &&
        Number.isFinite(version(item)) &&
        version(item) > version(record.base)
      ) {
        // A newer search row for a complete field family is the newest reading; unknown assignees stay owed.
        record.needsRead = item.assignees === undefined && record.base.assignees !== undefined
        record.base =
          item.assignees === undefined ? { ...item, assignees: record.base.assignees } : item
        this.emit(record)
      } else if (
        !sameFacts(item, record.base) &&
        (record.needsRead ||
          !Number.isFinite(version(item)) ||
          !Number.isFinite(version(record.base)) ||
          version(item) >= version(record.base))
      ) {
        record.needsRead = true
      }
      if (record.needsRead) {
        void this.verify(record)
      }
      return this.projectWith(item, record)
    })
  }
  canTrack(binding: TaskBinding) {
    return this.current(binding) && !this.unsupported.has(binding.incarnation)
  }
  operation(
    item: GitHubWorkItem,
    binding: TaskBinding,
    delta: TaskDelta
  ): (success: boolean) => GitHubWorkItem | null {
    if (item.type !== 'issue' || !this.canTrack(binding)) {
      return (success: boolean) => {
        const value = success ? delta(item) : item
        if (success) {
          this.publish(value, binding.observation)
        }
        return value
      }
    }
    const record = this.remember(item, binding)
    const token = {}
    record.pending.set(token, delta)
    record.revision = nextProviderRequestId()
    this.emit(record)
    let settled = false
    return (success: boolean) => {
      if (settled) {
        return this.current(binding) ? record.visible : null
      }
      settled = true
      if (this.record(item, binding) !== record) {
        // Disposed mid-flight (reconnect, account switch): settle the copies its begin patched, as main does.
        const value = success ? delta(item) : item
        this.publish(value, binding.observation)
        return value
      }
      if (success) {
        record.base = delta(record.base)
        record.needsRead = true
      }
      record.pending.delete(token)
      record.revision = nextProviderRequestId()
      this.emit(record)
      if (this.unsupported.has(binding.incarnation) && !record.pending.size) {
        // A server without the item route keeps no unresolved record once its last edit settles.
        this.records.delete(this.key(item, binding.observation.hostId))
      } else if (record.needsRead) {
        void this.verify(record)
      }
      return record.visible
    }
  }
  isPending(item: GitHubWorkItem, binding: TaskBinding) {
    return !!this.record(item, binding)?.pending.size
  }
  readRevision(item: GitHubWorkItem, binding: TaskBinding) {
    return this.record(item, binding)?.revision ?? 0
  }
  private verify(record: AcceptedTask): Promise<boolean> {
    if (!this.current(record.binding) || record.pending.size) {
      return Promise.resolve(false)
    }
    if (record.read) {
      // A Refresh read serves this obligation; if it doesn't publish, its completion owes one item read.
      return record.read.light ? record.read.promise : Promise.resolve(false)
    }
    return this.readCanonical(
      record.base,
      record.binding,
      async (accepts) => {
        const { repoId, hostId, source } = record.binding.observation
        const repo = (this.store.getState().repos ?? []).find(
          (r) => r.id === repoId && getRepoExecutionHostId(r) === hostId
        )
        const link = parseGitHubIssueOrPRLink(record.base.url)
        if (!repo || !link) {
          return null
        }
        return lookupGitHubWorkItemByOwnerRepoForSource({
          repoPath: repo.path,
          repoId: repo.id,
          sourceContext: source,
          accepts,
          ...link.slug,
          number: link.number,
          type: link.type
        })
      },
      true
    )
  }
  async readCanonical(
    item: GitHubWorkItem,
    binding: TaskBinding,
    load: (accepts: () => boolean) => Promise<GitHubWorkItem | null>,
    light = false
  ): Promise<boolean> {
    if (item.type !== 'issue' || !this.canTrack(binding)) {
      return false
    }
    const record = this.remember(item, binding)
    // A full conversation read waits for the existing item read.
    while (record.read) {
      await record.read.promise
    }
    if (record.pending.size || this.record(item, binding) !== record) {
      return false
    }
    const revision = record.revision,
      readOrder = nextProviderRequestId()
    const attempt = { revision, light, promise: Promise.resolve(false) }
    const accepts = () =>
      this.record(item, binding) === record &&
      record.revision === revision &&
      record.read === attempt &&
      !record.pending.size
    record.read = attempt
    attempt.promise = (async () => {
      try {
        const result = await load(accepts)
        if (
          !accepts() ||
          !result ||
          result.type !== item.type ||
          result.number !== item.number ||
          githubTaskIdentity(result) !== githubTaskIdentity(item) ||
          result.assignees === undefined ||
          (Number.isFinite(version(record.base)) &&
            (!Number.isFinite(version(result)) || version(result) < version(record.base)))
        ) {
          return false
        }
        record.base = { ...item, ...result }
        record.readOrder = readOrder
        record.needsRead = false
        this.emit(record)
        return true
      } catch (error) {
        if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
          this.unsupported.add(binding.incarnation)
          // Records with edits in flight stay until those settle so a failure still rolls back.
          for (const [key, entry] of this.records) {
            if (entry.binding.incarnation === binding.incarnation && !entry.pending.size) {
              this.records.delete(key)
            }
          }
          this.notify()
        }
        return false
      } finally {
        if (record.read === attempt) {
          record.read = undefined
        }
        // A write that crossed this read, or a Refresh that didn't publish, leaves one item read owed.
        if (
          (record.revision !== revision || !light) &&
          record.needsRead &&
          !record.pending.size &&
          this.record(item, binding) === record
        ) {
          void this.verify(record)
        }
      }
    })()
    return attempt.promise
  }
  projectOperation(
    row: GitHubProjectRow,
    target: RuntimeClientTarget,
    updates: Parameters<AppState['patchProjectIssueOrPr']>[2]
  ) {
    const identity = row.content.url && githubTaskIdentity({ url: row.content.url })
    const finishes =
      row.itemType !== 'ISSUE' || !identity
        ? []
        : [...this.records.values()]
            .filter(
              (record) =>
                this.current(record.binding) &&
                record.binding.observation.hostId === projectViewSourceScope(target) &&
                githubTaskIdentity(record.base) === identity
            )
            .map((record) =>
              this.operation(record.base, record.binding, (base) => {
                const labels = new Set(base.labels)
                for (const label of updates.addLabels ?? []) {
                  labels.add(label)
                }
                for (const label of updates.removeLabels ?? []) {
                  labels.delete(label)
                }
                const users = new Map(base.assignees?.map((user) => [login(user.login), user]))
                for (const value of updates.addAssignees ?? []) {
                  if (!users.has(login(value))) {
                    users.set(login(value), { login: value, name: null, avatarUrl: '' })
                  }
                }
                for (const value of updates.removeAssignees ?? []) {
                  users.delete(login(value))
                }
                return {
                  ...base,
                  ...(updates.title === undefined ? {} : { title: updates.title }),
                  labels: [...labels],
                  ...(base.assignees === undefined &&
                  !updates.addAssignees &&
                  !updates.removeAssignees
                    ? {}
                    : { assignees: [...users.values()] })
                }
              })
            )
    return (success: boolean) => {
      for (const finish of finishes) {
        finish(success)
      }
    }
  }
  /** Matching records per Project row: execution source, GitHub host, owner/repo and issue number. */
  private projectRecords(table: GitHubProjectTable, scope: string) {
    const groups = new Map<string, AcceptedTask[]>()
    for (const record of this.records.values()) {
      if (record.binding.observation.hostId === scope && this.current(record.binding)) {
        const key = githubTaskIdentity(record.base)
        groups.set(key, [...(groups.get(key) ?? []), record])
      }
    }
    return (row: GitHubProjectRow) => {
      const link = row.content.url ? parseGitHubIssueOrPRLink(row.content.url) : null
      const [owner, repo] = row.content.repository?.split('/') ?? []
      if (
        row.itemType !== 'ISSUE' ||
        !link ||
        link.type !== 'issue' ||
        link.number !== row.content.number ||
        !owner ||
        !repo ||
        githubRepoIdentityKey(link.slug) !==
          githubRepoIdentityKey({ owner, repo, host: table.project.host })
      ) {
        return []
      }
      const key = `${githubRepoIdentityKey(link.slug)}\0issue:${link.number}`
      return [...(groups.get(key) ?? [])].sort(newestFirst)
    }
  }
  /** Project rows are partial and unversioned: a conflict only triggers verification, never acceptance. */
  observeProject(table: GitHubProjectTable, target: RuntimeClientTarget) {
    if (!this.records.size) {
      return
    }
    const matchesFor = this.projectRecords(table, projectViewSourceScope(target))
    for (const row of table.rows) {
      const matches = matchesFor(row)
      const item = matches[0]?.visible
      const users = item?.assignees?.map((user) => login(user.login))
      if (
        item &&
        (row.content.title !== item.title ||
          row.content.state?.toLowerCase() !== item.state ||
          projectListConflicts(
            row.content.labels.map((label) => label.name),
            item.labels,
            PROJECT_LABEL_LIMIT
          ) ||
          (!!users &&
            projectListConflicts(
              row.content.assignees.map((user) => login(user.login)),
              users,
              PROJECT_ASSIGNEE_LIMIT
            )))
      ) {
        for (const candidate of matches) {
          candidate.needsRead = true
          void this.verify(candidate)
        }
      }
    }
  }
  /** Publish only title, state and label/assignee membership; board fields and profiles stay the row's. */
  projectTable(table: GitHubProjectTable, scope: string): GitHubProjectTable {
    if (!this.records.size) {
      return table
    }
    const matchesFor = this.projectRecords(table, scope)
    let changed = false
    const rows = table.rows.map((row) => {
      const item = matchesFor(row)[0]?.visible
      if (!item) {
        return row
      }
      const next = patchGitHubProjectRowContent(row, {
        title: item.title,
        state: item.state,
        labels: projectList(
          row.content.labels.map((label) => label.name),
          item.labels,
          PROJECT_LABEL_LIMIT
        ),
        ...(item.assignees === undefined
          ? {}
          : {
              assignees: projectList(
                row.content.assignees.map((user) => user.login),
                item.assignees.map((user) => user.login),
                PROJECT_ASSIGNEE_LIMIT,
                login
              )
            })
      })
      if (structuralValuesEqual(row, next)) {
        return row
      }
      changed = true
      return next
    })
    return changed ? { ...table, rows } : table
  }
}

export function createGitHubTaskRecordCache(store: StoreApi<AppState>) {
  const cache = new GitHubTaskRecordCache(store)
  store.subscribe((state, previous) => {
    if (
      state.repos !== previous.repos ||
      state.runtimeStatusByEnvironmentId !== previous.runtimeStatusByEnvironmentId ||
      state.runtimeEnvironments !== previous.runtimeEnvironments ||
      state.sshConnectionStates !== previous.sshConnectionStates ||
      state.sshStateByEnvironment !== previous.sshStateByEnvironment
    ) {
      cache.syncBindings(state.repos ?? [])
    }
  })
  return cache
}
