import { serializeAgentStatusEntry } from '@/runtime/sync-runtime-graph/agent-status-projection'
import { structuralValuesEqualIgnoringUndefined as equal } from '../../../../../shared/structural-value-equality'
import { isAiVaultTitleAgent } from '../../../../../shared/ai-vault/contracts/ai-vault-session-title'
import { AgentStatusProjection } from './agent-status-projection'
import type { AgentStatusChange } from './agent-status-contract'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'

export type AgentStatusReplacement = readonly [string, AgentStatusEntry | null]

/** Live read handle; capture() is the explicit historical-snapshot boundary. Records are immutable. */
export class AcceptedAgentStatuses implements ReadonlyMap<string, AgentStatusEntry> {
  readonly [Symbol.toStringTag] = 'AcceptedAgentStatuses'
  titleRevision = 0
  mobileToken: object = {}
  private pending: Map<string, AgentStatusEntry | null> | null = null
  private operations: AgentStatusReplacement[] = []
  private moved = new Set<string>()
  private refreshes: readonly string[] = []
  get refreshKeys(): readonly string[] {
    return this.refreshes
  }
  private count: number

  constructor(
    private readonly rows = new Map<string, AgentStatusEntry>(),
    readonly projection = new AgentStatusProjection(),
    private sleepingCount = 0
  ) {
    this.count = rows.size
  }

  subscribe(key: string, listener: () => void): () => void {
    return this.projection.subscribe(`status\0${key}`, listener)
  }
  subscribeChanges(listener: (keys: ReadonlySet<string> | null) => void): () => void {
    return this.projection.subscribeChanges(listener)
  }

  sharesOwner(other: AcceptedAgentStatuses): boolean {
    return this.rows === other.rows
  }

  get size(): number {
    return this.pending ? this.count : this.rows.size
  }
  get awakeSize(): number {
    return this.size - this.sleepingCount
  }

  get(key: string): AgentStatusEntry | undefined {
    return this.pending?.has(key) ? (this.pending.get(key) ?? undefined) : this.rows.get(key)
  }
  has(key: string): boolean {
    return this.get(key) !== undefined
  }

  replace(replacements: Iterable<AgentStatusReplacement>): AcceptedAgentStatuses {
    const draft = this.pending
      ? this
      : new AcceptedAgentStatuses(this.rows, this.projection, this.sleepingCount)
    draft.titleRevision = this.titleRevision
    draft.mobileToken = this.mobileToken
    draft.pending ??= new Map()
    for (const [key, value] of replacements) {
      const prior = draft.get(key)
      if (prior === (value ?? undefined)) {
        continue
      }
      draft.sleepingCount += Number(Boolean(value?.paneSleep)) - Number(Boolean(prior?.paneSleep))
      if (value === null && prior) {
        draft.count--
      } else if (value !== null && !prior) {
        draft.count++
        if (draft.rows.has(key) && draft.pending.has(key)) {
          draft.moved.add(key)
        }
        draft.pending.delete(key)
      }
      draft.pending.set(key, value)
      draft.operations.push([key, value])
    }
    return draft.operations.length ? draft : this
  }

  refresh(keys: readonly string[]): AcceptedAgentStatuses {
    const draft = this.pending
      ? this
      : new AcceptedAgentStatuses(this.rows, this.projection, this.sleepingCount)
    draft.titleRevision = this.titleRevision
    draft.mobileToken = this.mobileToken
    draft.pending ??= new Map()
    draft.refreshes = keys
    return draft
  }

  wasMoved(key: string): boolean {
    return this.moved.has(key)
  }

  *keysForTab(tabId: string): IterableIterator<string> {
    const yielded = new Set<string>()
    for (const key of this.projection.tabKeys(tabId)) {
      if (this.has(key)) {
        yielded.add(key)
        yield key
      }
    }
    for (const key of this.stagedKeys()) {
      if (!yielded.has(key) && key.startsWith(`${tabId}:`) && this.has(key)) {
        yield key
      }
    }
  }

  pendingKey(key: string): boolean {
    return this.pending?.has(key) ?? false
  }

  get replacementCount(): number {
    return this.operations.length
  }

  *replacementsSince(offset: number): IterableIterator<AgentStatusReplacement> {
    for (let index = offset; index < this.operations.length; index++) {
      yield this.operations[index]
    }
  }

  stagedKeys(): IterableIterator<string> {
    return (this.pending ?? new Map()).keys()
  }

  changes(): AgentStatusChange[] {
    const changes: AgentStatusChange[] = []
    for (const key of this.stagedKeys()) {
      const previous = this.rows.get(key),
        current = this.get(key)
      if (previous !== current || this.moved.has(key)) {
        changes.push({ paneKey: key, previous, current })
      }
    }
    return changes
  }

  /** Materialize fallible facts before either owner or presentation is published. */
  prepare(): () => void {
    const fact = (entry: AgentStatusEntry | undefined) =>
      entry && isAiVaultTitleAgent(entry.agentType) && entry.providerSession?.id
        ? [entry.agentType, entry.paneKey, entry.tabId, entry.worktreeId, entry.providerSession]
        : undefined
    const changes = this.changes()
    const titleChanged = changes.some(
      (change) => !equal(fact(change.previous), fact(change.current))
    )
    const mobileChanged = changes.some(
      ({ paneKey, previous, current }) =>
        (previous ? serializeAgentStatusEntry(paneKey, previous) : null) !==
        (current ? serializeAgentStatusEntry(paneKey, current) : null)
    )
    const titleRevision = this.titleRevision + Number(titleChanged)
    const mobileToken = mobileChanged ? {} : this.mobileToken
    return () => {
      this.titleRevision = titleRevision
      this.mobileToken = mobileToken
      for (const [key, value] of this.operations) {
        if (value === null) {
          this.rows.delete(key)
        } else {
          this.rows.set(key, value)
        }
      }
      this.pending = null
      this.operations = []
      this.moved.clear()
      this.refreshes = []
    }
  }

  capture(): AcceptedAgentStatuses {
    const captured = new AcceptedAgentStatuses(
      new Map(this),
      this.projection.capture(),
      this.sleepingCount
    )
    captured.titleRevision = this.titleRevision
    captured.mobileToken = this.mobileToken
    return captured
  }

  *entries(): MapIterator<[string, AgentStatusEntry]> {
    for (const [key, value] of this.rows) {
      if (this.moved.has(key)) {
        continue
      }
      const next = this.pending?.has(key) ? this.pending.get(key) : value
      if (next) {
        yield [key, next]
      }
    }
    if (this.pending) {
      for (const [key, value] of this.pending) {
        if (value && (!this.rows.has(key) || this.moved.has(key))) {
          yield [key, value]
        }
      }
    }
  }
  *keys(): MapIterator<string> {
    for (const [key] of this) {
      yield key
    }
  }
  *values(): MapIterator<AgentStatusEntry> {
    for (const [, value] of this) {
      yield value
    }
  }
  [Symbol.iterator](): MapIterator<[string, AgentStatusEntry]> {
    return this.entries()
  }
  forEach(
    callback: (
      value: AgentStatusEntry,
      key: string,
      map: ReadonlyMap<string, AgentStatusEntry>
    ) => void,
    thisArg?: unknown
  ): void {
    for (const [key, value] of this) {
      callback.call(thisArg, value, key, this)
    }
  }
}

export function acceptedAgentStatuses(
  rows: Iterable<readonly [string, AgentStatusEntry]> = []
): AcceptedAgentStatuses {
  const accepted = new Map(rows)
  let sleepingCount = 0
  for (const row of accepted.values()) {
    if (row.paneSleep) {
      sleepingCount++
    }
  }
  return new AcceptedAgentStatuses(accepted, undefined, sleepingCount)
}
