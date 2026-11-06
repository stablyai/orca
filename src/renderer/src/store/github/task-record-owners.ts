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
import { getWorkItemRepo } from '@/lib/work-item-repo-row'
import { parseGitHubIssueOrPRLink } from '../../../../shared/github/links'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { nextProviderRequestId } from './request-coordination'
import { isHostIdentityContinued, isHostIdentityFenceCurrent } from '../host-catalog-fencing'
import { applyTaskChange } from './task-change'
import {
  bindingKey,
  connection,
  contribute,
  facts,
  sameFacts,
  withFacts,
  type AcceptedTask,
  type BindingIncarnation,
  type TaskBinding
} from './task-record-model'

/** Bindings, owner lifetime and what stored or displayed copies of an owned issue show. */
export abstract class TaskRecordOwners {
  protected bindings = new Map<
    string,
    { signature: string; incarnation: BindingIncarnation; id: number; unsupported?: string }
  >()
  protected records = new Map<string, AcceptedTask>()
  protected listeners = new Set<() => void>()
  protected projections = new WeakMap<GitHubWorkItem, { stamp: object; value: GitHubWorkItem }>()
  protected revision = 0
  constructor(protected store: Pick<StoreApi<AppState>, 'getState'>) {}
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
        this.bindings.set(key, {
          signature,
          incarnation: { kind: 'task-binding-incarnation' },
          id: nextProviderRequestId()
        })
      }
    }
    for (const key of this.bindings.keys()) {
      if (!live.has(key)) {
        this.bindings.delete(key)
      }
    }
    let changed = false
    const reconnected = new Set<BindingIncarnation>()
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
  protected owns(binding: TaskBinding) {
    const { hostId, repoId, fence } = binding.observation
    return (
      this.bindings.get(`${hostId}\0${repoId}`)?.incarnation === binding.incarnation &&
      isHostIdentityContinued(fence)
    )
  }
  protected repo(repoId: string, hostId: string) {
    return (this.store.getState().repos ?? []).find(
      (r) => r.id === repoId && getRepoExecutionHostId(r) === hostId
    )
  }
  /** A reconnect re-captures the owner's observation; losing the account, repo or machine ends it. */
  protected keep(key: string, record: AcceptedTask) {
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
  protected unsupported(binding: TaskBinding) {
    const { hostId, repoId, fence } = binding.observation
    return this.bindings.get(`${hostId}\0${repoId}`)?.unsupported === connection(fence)
  }
  bindingIdentity(binding: TaskBinding) {
    const { hostId, repoId } = binding.observation
    return this.bindings.get(`${hostId}\0${repoId}`)?.id ?? 0
  }
  protected key(item: GitHubWorkItem, hostId: string) {
    return `${hostId}\0${item.repoId}\0${githubTaskIdentity(item)}`
  }
  protected record(item: GitHubWorkItem, binding: TaskBinding) {
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
  protected remember(item: GitHubWorkItem, binding: TaskBinding) {
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
  protected retire(record: AcceptedTask) {
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
  protected emit(record: AcceptedTask) {
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
  protected accept(record: AcceptedTask, base: GitHubWorkItem) {
    const previous = record.base
    record.base = base
    if (!previous || !sameFacts(previous, base, false)) {
      this.publish(base, record.binding.observation)
    }
  }
  /** What a stored copy may hold: the accepted facts or confirmed changes, never pending ones. */
  protected stored(row: GitHubWorkItem, record: AcceptedTask): GitHubWorkItem {
    const base = record.base
    if (!base) {
      return applyTaskChange(row, record.confirmed)
    }
    return sameFacts(row, base) && (row.assignees !== undefined || base.assignees === undefined)
      ? row
      : withFacts(row, base)
  }
  protected publish(value: GitHubWorkItem, observation: GitHubTaskObservation) {
    const ownerRepo = parseGitHubIssueOrPRLink(value.url)?.slug
    for (const { source } of observation.associations) {
      this.store.getState().patchWorkItem(value.id, facts(value), value.repoId, {
        sourceContext: source,
        ownerRepo
      })
    }
  }
  protected notify() {
    this.revision++
    for (const listener of this.listeners) {
      listener()
    }
  }
  /** An accepted record shows its facts; before one, each copy shows its own facts plus only the edits. */
  protected projectWith(row: GitHubWorkItem, record: AcceptedTask): GitHubWorkItem {
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
  /** Gives one owed read on the binding its turn (an external delivery or reconnect). */
  protected abstract wake(incarnation: BindingIncarnation): void
}
