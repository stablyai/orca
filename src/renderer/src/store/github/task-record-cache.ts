/* eslint-disable max-lines -- Binding disposal, write settlement, canonical reads and Project projection share one accepted record and ownership lane. */
import { deleteConfirmedListSnapshot } from '@/components/task-page/github/task-page-github-work-item-mutation-registry'
import { deleteLastConfirmedClientValue } from '@/components/task-page/github/task-page-github-confirmed-client-values'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { GitHubAssignableUser } from '../../../../shared/github/pull-request-types'
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
import { lookupReposBySlugFromCache } from '@/lib/repo-slug-cache'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { parseGitHubIssueOrPRLink } from '../../../../shared/github/links'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { structuralValuesEqual } from '../../../../shared/structural-value-equality'
import { nextProviderRequestId } from './request-coordination'
import { projectViewSourceScope } from './cache-identity'
import {
  isHostIdentityContinued,
  isHostIdentityFenceCurrent,
  type HostIdentityFence
} from '../host-catalog-fencing'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'
import { patchGitHubProjectRowContent } from './project-row-actions'
import { buildProjectWorkItem } from '@/components/github-project/project-work-item'
import {
  applyTaskChange,
  composeTaskChanges,
  isEmptyTaskChange,
  publishTaskChange,
  untrackedTaskOperation,
  type TaskChange,
  type TaskFacts
} from './task-change'
import type { GitHubProjectRow, GitHubProjectTable } from '../../../../shared/github/project-types'

export type TaskBinding = { observation: GitHubTaskObservation; incarnation: object }
type AcceptedTask = {
  binding: TaskBinding
  /** Addresses the issue (id, repo, URL); its facts are never projected or accepted. */
  address: GitHubWorkItem
  /** Only an accepted, current, owned provider reading sets the base. */
  base?: GitHubWorkItem
  visible?: GitHubWorkItem
  /** Before a base: the coalesced successful edits no accepted reading has covered yet. */
  confirmed?: TaskChange
  pending: Map<object, TaskChange>
  revision: number
  readOrder: number
  needsRead: boolean
  read?: { revision: number; light: boolean; promise: Promise<boolean> }
  /** When its last owned read came back unusable: it waits for an external delivery, oldest first. */
  failedAt?: number
  /** Replaced whenever what the record projects may have changed. */
  stamp: object
}
// Project rows carry the first 10 labels and 5 assignees (project-view-query-fragments.ts).
const PROJECT_LABEL_LIMIT = 10
const PROJECT_ASSIGNEE_LIMIT = 5
const version = (item: GitHubWorkItem | undefined) =>
  item ? Date.parse(item.updatedAt) : Number.NaN
const login = (value: string) => value.toLowerCase()
const sorted = (values: readonly string[]) => [...values].sort().join('\0')
const logins = (item: TaskFacts) => item.assignees?.map((user) => login(user.login))
const bindingKey = (repo: Repo) => `${getRepoExecutionHostId(repo)}\0${repo.id}`
/** The connection a fence was captured on; a reconnect or upgrade makes server support unknown again. */
const connection = ({
  pairingRevision,
  runtimeConnectionGeneration,
  sshTargetConnectionGeneration
}: HostIdentityFence) =>
  `${pairingRevision}\0${runtimeConnectionGeneration}\0${sshTargetConnectionGeneration}`
const sources = (record: AcceptedTask) =>
  record.binding.observation.associations.map(({ source }) => source)

/** Records own state, label-name and assignee-login membership; profiles and presentation follow the latest row. */
function sameFacts(a: TaskFacts, b: TaskFacts, unknownAssigneesMatch = true): boolean {
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
/** A value plus the record's unverified and pending changes, in order. */
function contribute<T extends TaskFacts>(value: T, record: AcceptedTask): T {
  let next = applyTaskChange(value, record.confirmed)
  for (const change of record.pending.values()) {
    next = applyTaskChange(next, change)
  }
  return next
}
/** Panel rule: an ISSUE row with a concrete URL whose repository and number agree on the board's host. */
function projectIssueLink(row: GitHubProjectRow, host: string | undefined) {
  const link = row.content.url ? parseGitHubIssueOrPRLink(row.content.url) : null
  const [owner, repo] = row.content.repository?.split('/') ?? []
  return row.itemType === 'ISSUE' &&
    link?.type === 'issue' &&
    link.number === row.content.number &&
    owner &&
    repo &&
    githubRepoIdentityKey(link.slug) === githubRepoIdentityKey({ owner, repo, host })
    ? link
    : null
}
/** A board row's own (possibly truncated) facts, so pending changes apply to what it shows. */
function projectRowFacts(row: GitHubProjectRow): TaskFacts {
  return {
    title: row.content.title,
    state: row.content.state === 'CLOSED' ? 'closed' : 'open',
    labels: row.content.labels.map((label) => label.name),
    assignees: row.content.assignees.map((user) => ({
      login: user.login,
      name: user.name,
      avatarUrl: user.avatarUrl ?? ''
    }))
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
  private bindings = new Map<
    string,
    { signature: string; incarnation: object; id: number; unsupported?: string }
  >()
  private records = new Map<string, AcceptedTask>()
  private listeners = new Set<() => void>()
  private projections = new WeakMap<GitHubWorkItem, { stamp: object; value: GitHubWorkItem }>()
  private revision = 0
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
    const reconnected = new Set<object>()
    for (const [key, record] of this.records) {
      const observed = record.binding
      if (!this.keep(key, record)) {
        changed = true
      } else if (record.binding !== observed) {
        reconnected.add(record.binding.incarnation)
      }
    }
    if (changed) {
      this.notify()
    }
    // A reconnect is a new chance for a read still owed on that binding.
    for (const incarnation of reconnected) {
      this.wake(incarnation)
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
  /** Same account, repo and machine: what a record's data belongs to, unlike one connection's fence. */
  private owns(binding: TaskBinding) {
    const { hostId, repoId, fence } = binding.observation
    return (
      this.bindings.get(`${hostId}\0${repoId}`)?.incarnation === binding.incarnation &&
      isHostIdentityContinued(fence)
    )
  }
  private repo(repoId: string, hostId: string) {
    return (this.store.getState().repos ?? []).find(
      (r) => r.id === repoId && getRepoExecutionHostId(r) === hostId
    )
  }
  /** A reconnect re-captures the owner's observation; losing the account, repo or machine ends it. */
  private keep(key: string, record: AcceptedTask) {
    if (this.current(record.binding)) {
      return true
    }
    const { repoId, hostId, source } = record.binding.observation
    const repo = this.owns(record.binding) ? this.repo(repoId, hostId) : undefined
    const observation = repo && captureGitHubTaskObservation(repo, source)
    if (observation) {
      record.binding = { observation, incarnation: record.binding.incarnation }
      if (this.current(record.binding)) {
        return true
      }
    }
    this.records.delete(key)
    return false
  }
  private unsupported(binding: TaskBinding) {
    const { hostId, repoId, fence } = binding.observation
    return this.bindings.get(`${hostId}\0${repoId}`)?.unsupported === connection(fence)
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
    return record &&
      this.keep(key, record) &&
      record.binding.incarnation === binding.incarnation &&
      this.current(binding)
      ? record
      : undefined
  }
  /** Joins or creates the issue's owner; a caller's item only addresses it and never becomes its base. */
  private remember(item: GitHubWorkItem, binding: TaskBinding) {
    let record = this.record(item, binding)
    if (!record) {
      record = {
        binding,
        address: item,
        pending: new Map(),
        revision: 0,
        readOrder: 0,
        needsRead: false,
        stamp: {}
      }
      this.records.set(this.key(item, binding.observation.hostId), record)
    }
    return record
  }
  /** An owner with no base, edits, owed read or read in flight holds nothing and retires. */
  private retire(record: AcceptedTask) {
    const key = this.key(record.address, record.binding.observation.hostId)
    if (
      !record.base &&
      !record.confirmed &&
      !record.pending.size &&
      !record.needsRead &&
      !record.read &&
      this.records.get(key) === record
    ) {
      this.records.delete(key)
      return true
    }
    return false
  }
  private emit(record: AcceptedTask) {
    record.stamp = {}
    // Pending changes reach users only through projection; stored copies never hold them.
    record.visible = record.base && contribute(record.base, record)
    const { associations, hostId } = record.binding.observation
    const scopes: (string | null)[] = associations.map((association) => association.scope)
    if (hostId === 'local') {
      scopes.push(null)
    }
    // The record supersedes the older confirmed-value holds for these families.
    const { repoId, id } = record.address
    for (const scope of scopes) {
      deleteLastConfirmedClientValue(scope, repoId, id, 'state')
      deleteConfirmedListSnapshot(scope, repoId, id, 'assignees')
    }
    this.notify()
  }
  /** Installs an accepted reading; stored copies take its facts (never pending changes). */
  private accept(record: AcceptedTask, base: GitHubWorkItem) {
    const previous = record.base
    record.base = base
    if (!previous || !sameFacts(previous, base, false)) {
      this.publish(base, record.binding.observation)
    }
  }
  /** What a stored copy may hold: the accepted facts or confirmed changes, never pending ones. */
  private stored(row: GitHubWorkItem, record: AcceptedTask): GitHubWorkItem {
    const base = record.base
    if (!base) {
      return applyTaskChange(row, record.confirmed)
    }
    return sameFacts(row, base) && (row.assignees !== undefined || base.assignees === undefined)
      ? row
      : withFacts(row, base)
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
  /** An accepted record shows its facts; before one, each copy shows its own facts plus only the edits. */
  private projectWith(row: GitHubWorkItem, record: AcceptedTask): GitHubWorkItem {
    const visible = record.visible ?? contribute(row, record)
    if (
      sameFacts(row, visible) &&
      (row.assignees !== undefined || visible.assignees === undefined)
    ) {
      return row
    }
    const previous = this.projections.get(row)
    if (previous?.stamp === record.stamp) {
      return previous.value
    }
    const value = withFacts(row, visible)
    this.projections.set(row, { stamp: record.stamp, value })
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
  acceptSearch(
    rows: readonly GitHubWorkItem[],
    binding: TaskBinding | undefined
  ): readonly GitHubWorkItem[] {
    const stored = rows.map((item) => {
      const record = binding && this.record(item, binding)
      if (!record) {
        return item
      }
      // Search can't prove it includes an unverified edit, so an owner without a base never adopts it.
      if (
        record.base &&
        !record.needsRead &&
        !record.pending.size &&
        Number.isFinite(version(item)) &&
        version(item) > version(record.base)
      ) {
        // A newer search row for a complete field family is the newest reading; unknown assignees stay owed.
        record.needsRead = item.assignees === undefined && record.base.assignees !== undefined
        this.accept(
          record,
          item.assignees === undefined ? { ...item, assignees: record.base.assignees } : item
        )
        this.emit(record)
      } else if (
        record.base &&
        !sameFacts(item, record.base) &&
        (record.needsRead ||
          !Number.isFinite(version(item)) ||
          !Number.isFinite(version(record.base)) ||
          version(item) >= version(record.base))
      ) {
        record.needsRead = true
      }
      // A first owed read runs now; one that already failed waits for its turn below. The caller stores
      // the row, so it carries no pending change.
      if (record.needsRead && record.failedAt === undefined) {
        void this.verify(record)
      }
      return this.stored(item, record)
    })
    if (binding && this.current(binding)) {
      this.wake(binding.incarnation)
    }
    return stored
  }
  /** Each external delivery retries at most one owed read per binding, the longest-waiting first. */
  private wake(incarnation: object) {
    let next: AcceptedTask | undefined
    for (const record of this.records.values()) {
      if (
        record.binding.incarnation === incarnation &&
        record.needsRead &&
        !record.pending.size &&
        !record.read &&
        (!next || (record.failedAt ?? 0) < (next.failedAt ?? 0))
      ) {
        next = record
      }
    }
    if (next) {
      void this.verify(next)
    }
  }
  /** A live record keeps tracking its started edits even after its server proves unsupported. */
  canTrack(binding: TaskBinding, item?: GitHubWorkItem) {
    return (
      !!(item && this.record(item, binding)) ||
      (this.current(binding) && !this.unsupported(binding))
    )
  }
  /** Settle returns the caller's item with the owner's surviving changes (or the accepted value). */
  operation(
    item: GitHubWorkItem,
    binding: TaskBinding,
    change: TaskChange
  ): (success: boolean) => GitHubWorkItem {
    if (item.type !== 'issue' || !this.canTrack(binding, item)) {
      const associations = binding.observation.associations.map(({ source }) => source)
      return untrackedTaskOperation(this.store, item, change, associations)
    }
    const record = this.remember(item, binding)
    const token = {}
    record.pending.set(token, change)
    record.revision = nextProviderRequestId()
    this.emit(record)
    const value = () => record.visible ?? contribute(item, record)
    let settled = false
    return (success: boolean) => {
      if (settled) {
        return value()
      }
      settled = true
      const live = this.record(item, record.binding) === record
      record.pending.delete(token)
      record.revision = nextProviderRequestId()
      if (success) {
        // A newly settled write is owed its own first read, whatever an earlier read's outcome was.
        record.needsRead = true
        record.failedAt = undefined
        if (record.base) {
          record.base = applyTaskChange(record.base, change)
        } else {
          // No accepted reading yet: copies take only this change, and it stays owed until one arrives.
          record.confirmed = composeTaskChanges(record.confirmed, change)
        }
      }
      // Stored copies never held this pending change: a failure only drops its token, and a success
      // applies just its own change to each copy's current value.
      if (!live) {
        // Disposed mid-flight: the owner still settles through its reducer, and a replacement record
        // reconciles through its own canonical read.
        record.visible = record.base && contribute(record.base, record)
        const replacement = this.records.get(this.key(item, binding.observation.hostId))
        if (replacement && this.current(replacement.binding)) {
          replacement.needsRead = true
          void this.verify(replacement)
        } else if (success) {
          publishTaskChange(this.store, item, change, sources(record))
        }
        return value()
      }
      if (success) {
        publishTaskChange(this.store, item, change, sources(record))
      }
      this.retire(record)
      this.emit(record)
      if (this.unsupported(record.binding) && !record.pending.size) {
        // A server without the item route keeps no unresolved record once its last edit settles.
        this.records.delete(this.key(item, binding.observation.hostId))
      } else if (record.needsRead && record.failedAt === undefined) {
        void this.verify(record)
      }
      return value()
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
    const item = record.base ?? record.address
    return this.readCanonical(
      item,
      record.binding,
      (accepts) => this.itemRead(item.url, record.binding, accepts),
      true
    )
  }
  private async itemRead(url: string, binding: TaskBinding, accepts: () => boolean) {
    const { repoId, hostId, source } = binding.observation
    const repo = this.repo(repoId, hostId)
    const link = parseGitHubIssueOrPRLink(url)
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
  }
  /** The one lane that establishes or replaces a record's base; it never installs the caller's item. */
  async readCanonical(
    item: GitHubWorkItem,
    binding: TaskBinding,
    load: (accepts: () => boolean) => Promise<GitHubWorkItem | null>,
    light = false
  ): Promise<boolean> {
    // Admission is re-entered after every wait: the owner this read queued behind may have retired,
    // been replaced, or lost its binding or server support meanwhile.
    const admit = () =>
      item.type === 'issue' && this.canTrack(binding) ? this.remember(item, binding) : undefined
    let owner = admit()
    // A full conversation read waits for the existing item read.
    while (owner?.read) {
      await owner.read.promise
      owner = admit()
    }
    if (!owner || owner.pending.size) {
      return false
    }
    const record = owner
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
        if (!accepts()) {
          return false
        }
        if (
          !result ||
          result.type !== item.type ||
          result.number !== item.number ||
          githubTaskIdentity(result) !== githubTaskIdentity(item) ||
          result.assignees === undefined ||
          (Number.isFinite(version(record.base)) &&
            (!Number.isFinite(version(result)) || version(result) < version(record.base)))
        ) {
          // Unusable is not a reading: keep what is known and park until an external delivery.
          record.failedAt = nextProviderRequestId()
          return false
        }
        // This reading was captured after every confirmed edit settled, so it covers them.
        this.accept(record, { ...item, ...result })
        record.confirmed = undefined
        record.readOrder = readOrder
        record.needsRead = false
        record.failedAt = undefined
        this.emit(record)
        return true
      } catch (error) {
        const { hostId, repoId, fence } = binding.observation
        const entry = this.bindings.get(`${hostId}\0${repoId}`)
        if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
          // Only the connection that answered lacks the route; a late old answer says nothing new.
          if (entry && this.current(binding)) {
            entry.unsupported = connection(fence)
            // Records with edits in flight stay until those settle; a confirmed change is already on the
            // copies, so idle records simply retire.
            for (const [key, owner] of this.records) {
              if (owner.binding.incarnation === binding.incarnation && !owner.pending.size) {
                this.records.delete(key)
              }
            }
            this.notify()
          }
        } else if (accepts()) {
          record.failedAt = nextProviderRequestId()
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
        // A failed first Refresh with nothing else owed leaves no record behind.
        if (this.retire(record)) {
          this.notify()
        }
      }
    })()
    return attempt.promise
  }
  /** A Project issue edit is a record producer for every current repo binding of that issue on its source. */
  projectOperation(
    row: GitHubProjectRow,
    host: string | undefined,
    target: RuntimeClientTarget,
    updates: Parameters<AppState['patchProjectIssueOrPr']>[2]
  ) {
    const link = projectIssueLink(row, host)
    const change: TaskChange = {
      ...(updates.title === undefined ? {} : { title: updates.title }),
      labels: Object.fromEntries([
        ...(updates.addLabels ?? []).map((name): [string, boolean] => [name, true]),
        ...(updates.removeLabels ?? []).map((name): [string, boolean] => [name, false])
      ]),
      assignees: Object.fromEntries([
        ...(updates.addAssignees ?? []).map((value): [string, GitHubAssignableUser | null] => [
          login(value),
          { login: value, name: null, avatarUrl: '' }
        ]),
        ...(updates.removeAssignees ?? []).map((value): [string, GitHubAssignableUser | null] => [
          login(value),
          null
        ])
      ])
    }
    // A body-only or empty save owns no issue fact: no owner, revision or read.
    if (!link || isEmptyTaskChange(change)) {
      return () => {}
    }
    const finishes = this.projectOwners(row, link, host, projectViewSourceScope(target)).map(
      ({ address, binding }) => this.operation(address, binding, change)
    )
    return (success: boolean) => {
      for (const finish of finishes) {
        finish(success)
      }
    }
  }
  /** Current repo bindings for this issue on the board's source; a cached copy only addresses its owner. */
  private projectOwners(
    row: GitHubProjectRow,
    link: NonNullable<ReturnType<typeof projectIssueLink>>,
    host: string | undefined,
    scope: string
  ) {
    const { repos = [], workItemsCache } = this.store.getState()
    const identity = `${githubRepoIdentityKey(link.slug)}\0issue:${link.number}`
    const owners = new Map<string, { repo: Repo; address?: GitHubWorkItem }>()
    const add = (repo: Repo | undefined, address?: GitHubWorkItem) => {
      if (repo && !owners.get(bindingKey(repo))?.address) {
        owners.set(bindingKey(repo), { repo, address })
      }
    }
    for (const repo of lookupReposBySlugFromCache(
      repos,
      `${link.slug.owner}/${link.slug.repo}`,
      host
    )) {
      add(repo)
    }
    for (const record of this.records.values()) {
      const { hostId, repoId } = record.binding.observation
      if (this.current(record.binding) && githubTaskIdentity(record.address) === identity) {
        add(
          repos.find((r) => r.id === repoId && getRepoExecutionHostId(r) === hostId),
          record.address
        )
      }
    }
    for (const entry of Object.values(workItemsCache)) {
      for (const item of entry?.data ?? []) {
        if (item.type === 'issue' && githubTaskIdentity(item) === identity) {
          add(getWorkItemRepo(repos, item), item)
        }
      }
    }
    return [...owners.values()].flatMap(({ repo, address }) => {
      const binding = getRepoExecutionHostId(repo) === scope ? this.capture(repo) : undefined
      const item = address ?? buildProjectWorkItem(row, repo, host)
      // A binding known to lack the item route keeps main's board-only edit; a live owner still drains.
      return binding && item && this.canTrack(binding, item) ? [{ address: item, binding }] : []
    })
  }
  /** Matching records per Project row: execution source, GitHub host, owner/repo and issue number. */
  private projectRecords(table: GitHubProjectTable, scope: string) {
    const groups = new Map<string, AcceptedTask[]>()
    for (const record of this.records.values()) {
      if (record.binding.observation.hostId === scope && this.current(record.binding)) {
        const key = githubTaskIdentity(record.address)
        groups.set(key, [...(groups.get(key) ?? []), record])
      }
    }
    return (row: GitHubProjectRow) => {
      const link = projectIssueLink(row, table.project.host)
      if (!link) {
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
      const item = matches.find((match) => match.visible)?.visible
      const users = item?.assignees?.map((user) => login(user.login))
      const conflict =
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
      for (const candidate of matches) {
        if (conflict) {
          candidate.needsRead = true
        }
        if (conflict && candidate.failedAt === undefined) {
          void this.verify(candidate)
        }
      }
    }
    // A board fetch is an external delivery for every binding on its source.
    const scope = projectViewSourceScope(target)
    for (const incarnation of new Set(
      [...this.records.values()]
        .filter((record) => record.binding.observation.hostId === scope)
        .map((record) => record.binding.incarnation)
    )) {
      this.wake(incarnation)
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
      const matches = matchesFor(row)
      if (!matches.length) {
        return row
      }
      // The newest accepted reading wins; owners without one add only their own edits.
      let item: TaskFacts = matches.find((match) => match.visible)?.visible ?? projectRowFacts(row)
      for (const match of matches) {
        item = match.base ? item : contribute(item, match)
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
