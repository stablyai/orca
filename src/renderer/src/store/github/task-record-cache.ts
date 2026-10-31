/* eslint-disable max-lines -- Binding disposal, write settlement and canonical publication share one accepted record and ownership lane. */
import {
  deleteConfirmedListSnapshot,
  deleteStickyHideEntry,
  getTaskPageGitHubSoftHiddenItemKeys,
  updateSoftHiddenItemKey,
  notifyTaskPageGitHubMutationRegistry
} from '@/components/task-page/github/task-page-github-work-item-mutation-registry'
import { deleteLastConfirmedClientValue } from '@/components/task-page/github/task-page-github-confirmed-client-values'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { Repo } from '../../../../shared/repo-types'
import type { AppState } from '../types'
import type { StoreApi } from 'zustand'
import {
  captureGitHubTaskObservation,
  isGitHubTaskObservationCurrent,
  githubTaskBinding,
  observeGitHubWorkItem,
  getGitHubTaskObservation,
  type GitHubTaskObservation
} from '@/lib/github-task-observation'
import { githubTaskIdentity, githubTaskContent } from '@/lib/github-task-target'
import { lookupGitHubWorkItemByOwnerRepoForSource } from '@/lib/github-work-item-source-lookup'
import { getGitHubSourceRuntimeTarget } from '@/lib/github-source-runtime-context'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { parseGitHubIssueOrPRLink } from '../../../../shared/github/links'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { structuralValuesEqual } from '../../../../shared/structural-value-equality'
import { nextProviderRequestId } from './request-coordination'
import { projectViewSourceScope } from './cache-identity'
import {
  captureHostIdentityFence,
  isHostIdentityFenceCurrent,
  type HostIdentityFence
} from '../host-catalog-fencing'
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
  failed: boolean
  read?: { revision: number; promise: Promise<boolean> }
}
const version = (item: GitHubWorkItem) => Date.parse(item.updatedAt)
const sameContent = (a: GitHubWorkItem, b: GitHubWorkItem) =>
  structuralValuesEqual(githubTaskContent(a), githubTaskContent(b))

export class GitHubTaskRecordCache {
  private bindings = new Map<string, { signature: string; incarnation: object; id: number }>()
  private records = new Map<string, AcceptedTask>()
  private listeners = new Set<() => void>()
  private projectSources = new WeakMap<
    GitHubProjectTable,
    { raw: GitHubProjectTable; scope: string; fence: HostIdentityFence }
  >()
  private projections = new WeakMap<
    GitHubWorkItem,
    { visible: GitHubWorkItem; value: GitHubWorkItem }
  >()
  private pins = new Map<string, number>()
  private revision = 0
  private observations = new WeakMap<GitHubTaskObservation, object>()
  private unsupported = new WeakSet<object>()
  constructor(private store: Pick<StoreApi<AppState>, 'getState' | 'setState'>) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  snapshot = () => this.revision
  syncBindings(repos: readonly Repo[], sourceChanged = false) {
    let changed = sourceChanged
    const live = new Set<string>()
    for (const repo of repos) {
      const key = `${getRepoExecutionHostId(repo)}\0${repo.id}`
      live.add(key)
      const signature = githubTaskBinding(repo)
      if (this.bindings.get(key)?.signature !== signature) {
        this.bindings.set(key, { signature, incarnation: {}, id: nextProviderRequestId() })
        changed = true
      }
    }
    for (const key of this.bindings.keys()) {
      if (!live.has(key)) {
        this.bindings.delete(key)
        changed = true
      }
    }
    for (const [key, record] of this.records) {
      if (!this.current(record.binding)) {
        this.records.delete(key)
        changed = true
      }
    }
    if (changed) {
      this.publishProjects()
      this.notify()
    }
  }
  capture(repo: Repo | undefined, source?: TaskSourceContext | null): TaskBinding | undefined {
    if (!repo) {
      return undefined
    }
    this.syncBindings(this.store.getState().repos ?? [])
    const observation = captureGitHubTaskObservation(repo, source)
    const incarnation = this.bindings.get(
      `${getRepoExecutionHostId(repo)}\0${repo.id}`
    )?.incarnation
    if (observation && incarnation) {
      this.observations.set(observation, incarnation)
      return { observation, incarnation }
    }
    return undefined
  }
  current(binding: TaskBinding): boolean {
    const owner = binding.observation
    const repo = (this.store.getState().repos ?? []).find(
      (r) => r.id === owner.repoId && getRepoExecutionHostId(r) === owner.hostId
    )
    return (
      !!repo &&
      this.bindings.get(`${owner.hostId}\0${owner.repoId}`)?.incarnation === binding.incarnation &&
      isGitHubTaskObservationCurrent(owner, repo)
    )
  }
  private key(item: GitHubWorkItem, binding: TaskBinding) {
    return `${binding.observation.aliases.slice().sort().join('\0')}\0${githubTaskIdentity(item)}`
  }
  private record(item: GitHubWorkItem, binding: TaskBinding) {
    const record = this.records.get(this.key(item, binding))
    return record?.binding.incarnation === binding.incarnation && this.current(binding)
      ? record
      : undefined
  }
  private emit(record: AcceptedTask) {
    let visible = record.base
    for (const delta of record.pending.values()) {
      visible = delta(visible)
    }
    const changed = !sameContent(visible, record.visible)
    record.visible = observeGitHubWorkItem(visible, record.binding.observation)
    const state = this.store.getState()
    const scopes: (string | null)[] = record.binding.observation.associations.map((a) => a.scope)
    if (record.binding.observation.hostId === 'local') {
      scopes.push(null)
    }
    for (const scope of scopes) {
      deleteLastConfirmedClientValue(scope, visible.repoId, visible.id, 'state')
      deleteConfirmedListSnapshot(scope, visible.repoId, visible.id, 'assignees')
    }
    const itemKey = `${visible.repoId}\0${visible.id}`
    if (getTaskPageGitHubSoftHiddenItemKeys().has(itemKey)) {
      deleteStickyHideEntry(itemKey)
      updateSoftHiddenItemKey(itemKey, false)
      notifyTaskPageGitHubMutationRegistry()
    }
    const ownerRepo = parseGitHubIssueOrPRLink(visible.url)?.slug
    if (changed) {
      for (const source of record.binding.observation.associations.map((a) => a.source)) {
        state.patchWorkItem(visible.id, githubTaskContent(record.visible), visible.repoId, {
          sourceContext: source,
          ownerRepo
        })
      }
    }
    this.publishProjects()
    this.notify()
  }
  private notify() {
    this.revision++
    for (const listener of this.listeners) {
      listener()
    }
  }
  private publishProjects() {
    for (const [key, entry] of Object.entries(this.store.getState().projectViewCache)) {
      if (!entry.data) {
        continue
      }
      const data = this.projectObservedTable(entry.data)
      if (data !== entry.data) {
        this.store.setState((state) => ({
          projectViewCache: { ...state.projectViewCache, [key]: { ...entry, data } }
        }))
      }
    }
  }
  private remember(item: GitHubWorkItem, binding: TaskBinding) {
    let record = this.record(item, binding)
    if (!record) {
      const base = observeGitHubWorkItem(item, binding.observation)
      record = {
        binding,
        base,
        visible: base,
        pending: new Map(),
        revision: 0,
        readOrder: 0,
        needsRead: false,
        failed: false
      }
      this.records.set(this.key(item, binding), record)
    }
    return record
  }
  private evict() {
    if (this.records.size <= 500) {
      return
    }
    for (const [key, record] of this.records) {
      if (!this.pins.has(key) && !record.read && !record.pending.size) {
        this.records.delete(key)
      }
      if (this.records.size <= 500) {
        break
      }
    }
  }
  pin(item: GitHubWorkItem, binding: TaskBinding) {
    const key = this.key(item, binding)
    this.pins.set(key, (this.pins.get(key) ?? 0) + 1)
    return () => {
      const n = (this.pins.get(key) ?? 1) - 1
      if (n) {
        this.pins.set(key, n)
      } else {
        this.pins.delete(key)
      }
      this.evict()
    }
  }
  projectItem(item: GitHubWorkItem, binding?: TaskBinding): GitHubWorkItem {
    if (!binding || !this.current(binding)) {
      return item
    }
    const record = this.record(item, binding)
    if (
      !record ||
      (sameContent(item, record.visible) &&
        getGitHubTaskObservation(item) &&
        this.isObservedCurrent(item))
    ) {
      return item
    }
    const previous = this.projections.get(item)
    if (previous?.visible === record.visible) {
      return previous.value
    }
    const value = observeGitHubWorkItem(
      { ...item, ...githubTaskContent(record.visible) },
      binding.observation
    )
    this.projections.set(item, { visible: record.visible, value })
    return value
  }
  isObservedCurrent(item: GitHubWorkItem) {
    const owner = getGitHubTaskObservation(item)
    if (!owner) {
      return true
    }
    const incarnation = this.observations.get(owner)
    return !!incarnation && this.current({ observation: owner, incarnation })
  }
  pinObserved(item: GitHubWorkItem) {
    const owner = getGitHubTaskObservation(item)
    const incarnation = owner && this.observations.get(owner)
    return owner && incarnation ? this.pin(item, { observation: owner, incarnation }) : () => {}
  }
  hasFailed(item: GitHubWorkItem, binding: TaskBinding | undefined) {
    return !!binding && !!this.record(item, binding)?.failed
  }
  bindingIdentity(binding: TaskBinding) {
    return (
      this.bindings.get(`${binding.observation.hostId}\0${binding.observation.repoId}`)?.id ?? 0
    )
  }
  projectObserved(item: GitHubWorkItem): GitHubWorkItem {
    const observation = getGitHubTaskObservation(item)
    if (!observation) {
      return item
    }
    const record = this.records.get(
      `${observation.aliases.slice().sort().join('\0')}\0${githubTaskIdentity(item)}`
    )
    if (
      record &&
      record.binding.incarnation === this.observations.get(observation) &&
      this.current(record.binding)
    ) {
      return this.projectItem(item, record.binding)
    }
    return item
  }
  projectObservedItems(rows: readonly GitHubWorkItem[]): readonly GitHubWorkItem[] {
    const projected = rows
      .filter((item) => this.isObservedCurrent(item))
      .map((item) => this.projectObserved(item))
    return projected.length === rows.length &&
      projected.every((item, index) => item === rows[index])
      ? rows
      : projected
  }
  acceptSearch(
    rows: readonly GitHubWorkItem[],
    binding: TaskBinding | undefined,
    previous: readonly GitHubWorkItem[] = []
  ): readonly GitHubWorkItem[] {
    if (binding && !this.current(binding)) {
      return []
    }
    const knownRows = new Map(previous.map((item) => [githubTaskIdentity(item), item]))
    return rows
      .filter((item) => this.isObservedCurrent(item))
      .map((item) => {
        const known = knownRows.get(githubTaskIdentity(item))
        const record = binding && this.record(item, binding)
        if (!record) {
          return known &&
            Number.isFinite(version(known)) &&
            (!Number.isFinite(version(item)) || version(known) > version(item))
            ? known
            : observeGitHubWorkItem(item, binding?.observation)
        }
        const conflict = !sameContent(item, record.base)
        if (
          !record.needsRead &&
          !record.pending.size &&
          Number.isFinite(version(item)) &&
          version(item) > version(record.base)
        ) {
          const incomplete = item.assignees === undefined && record.base.assignees !== undefined
          record.base = observeGitHubWorkItem(
            {
              ...item,
              ...(item.assignees === undefined ? { assignees: record.base.assignees } : {})
            },
            record.binding.observation
          )
          if (incomplete) {
            record.needsRead = true
          }
          this.emit(record)
          if (record.needsRead) {
            void this.verify(record)
          }
        } else if (
          conflict &&
          (record.needsRead ||
            !Number.isFinite(version(item)) ||
            !Number.isFinite(version(record.base)) ||
            version(item) >= version(record.base))
        ) {
          record.needsRead = true
          void this.verify(record)
        } else if (record.needsRead) {
          void this.verify(record)
        }
        return this.projectItem(item, binding)
      })
  }
  canTrack(binding: TaskBinding) {
    return (
      this.current(binding) &&
      !this.unsupported.has(binding.incarnation) &&
      (getGitHubSourceRuntimeTarget(binding.observation.source).kind !== 'local' ||
        typeof window.api.gh.workItemByOwnerRepo === 'function')
    )
  }
  operation(
    item: GitHubWorkItem,
    binding: TaskBinding,
    delta: TaskDelta
  ): (success: boolean) => GitHubWorkItem | null {
    if (!this.canTrack(binding)) {
      return (success: boolean) => {
        if (!this.current(binding)) {
          return null
        }
        const value = success ? delta(item) : item
        if (success) {
          this.store.getState().patchWorkItem(item.id, githubTaskContent(value), item.repoId, {
            sourceContext: binding.observation.source,
            ownerRepo: parseGitHubIssueOrPRLink(item.url)?.slug
          })
        }
        return value
      }
    }
    const record = this.remember(item, binding)
    const token = {}
    record.pending.set(token, delta)
    record.revision = nextProviderRequestId()
    this.emit(record)
    this.evict()
    let settled = false
    return (success: boolean) => {
      if (settled) {
        return this.current(binding) ? record.visible : null
      }
      settled = true
      if (!this.current(binding) || this.record(item, binding) !== record) {
        return null
      }
      if (success) {
        record.base = delta(record.base)
        record.needsRead = true
      }
      record.pending.delete(token)
      record.revision = nextProviderRequestId()
      this.emit(record)
      if (record.needsRead) {
        void this.verify(record)
      }
      return record.visible
    }
  }
  private verify(record: AcceptedTask): Promise<boolean> {
    if (!this.current(record.binding) || record.pending.size) {
      return Promise.resolve(false)
    }
    if (record.read) {
      return record.read.promise
    }
    return this.readCanonical(record.base, record.binding, async (accepts) => {
      const repo = (this.store.getState().repos ?? []).find(
        (r) =>
          r.id === record.binding.observation.repoId &&
          getRepoExecutionHostId(r) === record.binding.observation.hostId
      )
      const link = parseGitHubIssueOrPRLink(record.base.url)
      if (!repo || !link) {
        return null
      }
      return lookupGitHubWorkItemByOwnerRepoForSource({
        repoPath: repo.path,
        repoId: repo.id,
        sourceContext: record.binding.observation.source,
        accepts,
        ...link.slug,
        number: link.number,
        type: link.type
      })
    })
  }
  async readCanonical(
    item: GitHubWorkItem,
    binding: TaskBinding,
    load: (accepts: () => boolean) => Promise<GitHubWorkItem | null>
  ): Promise<boolean> {
    if (!this.current(binding) || this.unsupported.has(binding.incarnation)) {
      return false
    }
    const record = this.remember(item, binding)
    // A full conversation read waits for the existing item read; verification joins either kind.
    while (record.read) {
      await record.read.promise
    }
    if (!this.current(binding) || record.pending.size || this.record(item, binding) !== record) {
      return false
    }
    record.failed = false
    const revision = record.revision,
      readOrder = nextProviderRequestId()
    const attempt = { revision, promise: Promise.resolve(false) }
    const accepts = () =>
      this.current(binding) &&
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
        record.base = observeGitHubWorkItem({ ...item, ...result }, binding.observation)
        record.readOrder = readOrder
        record.needsRead = false
        record.failed = false
        this.emit(record)
        return true
      } catch (error) {
        if (
          error instanceof RuntimeRpcCallError &&
          ['method_not_found', 'unknown_method', 'not_found'].includes(error.code)
        ) {
          this.unsupported.add(binding.incarnation)
          for (const [key, entry] of this.records) {
            if (entry.binding.incarnation === binding.incarnation) {
              this.records.delete(key)
            }
          }
          this.publishProjects()
          this.notify()
        }
        return false
      } finally {
        if (record.read === attempt) {
          record.read = undefined
        }
        if (
          this.record(item, binding) === record &&
          record.revision === revision &&
          record.needsRead
        ) {
          record.failed = true
          this.notify()
        }
        if (
          record.revision !== revision &&
          record.needsRead &&
          !record.pending.size &&
          this.current(binding)
        ) {
          void this.verify(record)
        }
        this.evict()
      }
    })()
    return attempt.promise
  }
  readRevision(item: GitHubWorkItem, binding: TaskBinding) {
    return this.remember(item, binding).revision
  }
  copyProjectTable(previous: GitHubProjectTable, next: GitHubProjectTable) {
    const source = this.projectSources.get(previous)
    if (!source) {
      return next
    }
    const originals = new Map(source.raw.rows.map((row) => [row.id, row]))
    const previousRows = new Map(previous.rows.map((row) => [row.id, row]))
    const raw = {
      ...next,
      rows: next.rows.map((row) => {
        const prior = previousRows.get(row.id),
          original = originals.get(row.id)
        if (!prior || !original) {
          return row
        }
        const content = { ...row.content }
        for (const field of ['title', 'state', 'labels', 'assignees'] as const) {
          if (structuralValuesEqual(prior.content[field], row.content[field])) {
            Object.assign(content, { [field]: original.content[field] })
          }
        }
        return { ...row, content }
      })
    }
    this.projectSources.set(next, { ...source, raw })
    return next
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
                const users = new Map(
                  base.assignees?.map((user) => [user.login.toLowerCase(), user])
                )
                for (const login of updates.addAssignees ?? []) {
                  if (!users.has(login.toLowerCase())) {
                    users.set(login.toLowerCase(), { login, name: null, avatarUrl: '' })
                  }
                }
                for (const login of updates.removeAssignees ?? []) {
                  users.delete(login.toLowerCase())
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
  pinProject(table: GitHubProjectTable) {
    const source = this.projectSources.get(table)
    if (!source) {
      return () => {}
    }
    const identities = new Set(
      table.rows
        .filter((row) => row.itemType === 'ISSUE' && row.content.repository && row.content.url)
        .map((row) => {
          const link = parseGitHubIssueOrPRLink(row.content.url ?? '')
          return link ? `${githubRepoIdentityKey(link.slug)}\0${link.type}:${link.number}` : ''
        })
    )
    const releases = [...this.records.values()]
      .filter(
        (record) =>
          record.binding.observation.hostId === source.scope &&
          identities.has(githubTaskIdentity(record.base))
      )
      .map((record) => this.pin(record.base, record.binding))
    return () => {
      for (const release of releases) {
        release()
      }
    }
  }
  observeProject(
    table: GitHubProjectTable,
    target: RuntimeClientTarget,
    fence = captureHostIdentityFence({ target, at: 'local' })
  ) {
    this.projectSources.set(table, { raw: table, scope: projectViewSourceScope(target), fence })
    return this.projectObservedTable(table, true)
  }
  projectObservedTable(table: GitHubProjectTable, verify = false): GitHubProjectTable {
    const source = this.projectSources.get(table)
    if (!source || !isHostIdentityFenceCurrent(source.fence)) {
      return table
    }
    const groups = new Map<string, AcceptedTask[]>()
    for (const record of this.records.values()) {
      if (!this.current(record.binding) || record.binding.observation.hostId !== source.scope) {
        continue
      }
      const key = githubTaskIdentity(record.base)
      groups.set(key, [...(groups.get(key) ?? []), record])
    }
    let changed = false
    const rows = source.raw.rows.map((row) => {
      const link = row.content.url && parseGitHubIssueOrPRLink(row.content.url)
      if (
        row.itemType !== 'ISSUE' ||
        !row.content.repository ||
        !link ||
        link.type !== 'issue' ||
        link.number !== row.content.number ||
        githubRepoIdentityKey(link.slug) !==
          githubRepoIdentityKey({
            owner: row.content.repository.split('/')[0],
            repo: row.content.repository.split('/')[1],
            host: source.raw.project.host
          })
      ) {
        return row
      }
      const matches =
        groups.get(`${githubRepoIdentityKey(link.slug)}\0${link.type}:${link.number}`) ?? []
      if (!matches.length) {
        return row
      }
      matches.sort((a, b) => {
        if (a.revision || b.revision) {
          const order = b.revision - a.revision
          if (order && (a.needsRead || a.pending.size || b.needsRead || b.pending.size)) {
            return order
          }
        }
        const av = version(a.base),
          bv = version(b.base)
        return (
          (Number.isFinite(av) && Number.isFinite(bv) ? bv - av : 0) || b.readOrder - a.readOrder
        )
      })
      const record = matches[0],
        item = record.visible,
        content = row.content
      const conflict =
        content.title !== item.title ||
        content.state?.toLowerCase() !== item.state ||
        !structuralValuesEqual(
          content.labels.map((label) => label.name),
          item.labels
        ) ||
        !structuralValuesEqual(
          content.assignees.map((user) => user.login),
          item.assignees?.map((user) => user.login)
        )
      if (verify && conflict) {
        for (const candidate of matches) {
          candidate.needsRead = true
          void this.verify(candidate)
        }
      }
      const next = patchGitHubProjectRowContent(row, {
        title: item.title,
        state: item.state,
        labels: item.labels,
        ...(item.assignees === undefined
          ? {}
          : { assignees: item.assignees.map((user) => user.login) })
      })
      if (structuralValuesEqual(row, next)) {
        return row
      }
      changed = true
      return next
    })
    const projected = changed ? { ...source.raw, rows } : source.raw
    if (structuralValuesEqual(projected, table)) {
      return table
    }
    this.projectSources.set(projected, source)
    return projected
  }
}
