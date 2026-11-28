import { structuralValuesEqualIgnoringUndefined as equal } from '../../../../../../shared/collections/structural-value-equality'
import { isAiVaultTitleAgent } from '../../../../../../shared/ai-vault/contracts/ai-vault-session-title'
import { AgentStatusProjection } from '../projection/agent-status-projection'
import type { AgentStatusChange } from '../contracts/agent-status-contract'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'

export type AgentStatusReplacement = readonly [string, AgentStatusEntry | null]

const EMPTY_PENDING_MAP = new Map<string, AgentStatusEntry | null>()
const EMPTY_CHANGES: AgentStatusChange[] = []
const EMPTY_REFRESHES: readonly string[] = []
const NOOP_COMMIT = (): void => {}

/** Live read handle; capture() is the explicit historical-snapshot boundary. Records are immutable. */
export class AcceptedAgentStatuses implements ReadonlyMap<string, AgentStatusEntry> {
  readonly [Symbol.toStringTag] = 'AcceptedAgentStatuses'
  titleRevision = 0
  /** Like titleRevision, but over every agent's session identity (the saved terminal names read it). */
  sessionRevision = 0
  private pending: Map<string, AgentStatusEntry | null> | null = null
  private operations: AgentStatusReplacement[] = []
  private moved = new Set<string>()
  private refreshes: readonly string[] = EMPTY_REFRESHES
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
    draft.sessionRevision = this.sessionRevision
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
    draft.sessionRevision = this.sessionRevision
    draft.pending ??= new Map()
    draft.refreshes = keys
    return draft
  }

  wasMoved(key: string): boolean {
    return this.moved.has(key)
  }

  *keysForTab(tabId: string): IterableIterator<string> {
    if (!this.pending || this.pending.size === 0) {
      for (const key of this.projection.tabKeys(tabId)) {
        if (this.rows.has(key)) {
          yield key
        }
      }
      return
    }
    const yielded = new Set<string>()
    for (const key of this.projection.tabKeys(tabId)) {
      if (this.has(key)) {
        yielded.add(key)
        yield key
      }
    }
    const prefix = `${tabId}:`
    for (const key of this.pending.keys()) {
      if (!yielded.has(key) && key.startsWith(prefix) && this.has(key)) {
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
    return (this.pending ?? EMPTY_PENDING_MAP).keys()
  }

  changes(): AgentStatusChange[] {
    if (!this.pending || this.pending.size === 0) {
      return EMPTY_CHANGES
    }
    const changes: AgentStatusChange[] = []
    for (const key of this.pending.keys()) {
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
    if (
      !this.pending &&
      this.operations.length === 0 &&
      this.moved.size === 0 &&
      this.refreshes.length === 0
    ) {
      return NOOP_COMMIT
    }
    const changes = this.changes()
    let titleRevision = this.titleRevision
    let sessionRevision = this.sessionRevision
    if (changes.length > 0) {
      const sessionFact = (entry: AgentStatusEntry | undefined) =>
        entry?.providerSession?.id
          ? [entry.agentType, entry.paneKey, entry.tabId, entry.worktreeId, entry.providerSession]
          : undefined
      const fact = (entry: AgentStatusEntry | undefined) =>
        entry && isAiVaultTitleAgent(entry.agentType) ? sessionFact(entry) : undefined
      // A moved key changes iteration order, which picks between equal-priority panes of one tab.
      const changedBy = (read: typeof fact) =>
        changes.some(
          (change) =>
            !equal(read(change.previous), read(change.current)) ||
            (this.moved.has(change.paneKey) && read(change.current) !== undefined)
        )
      titleRevision += Number(changedBy(fact))
      sessionRevision += Number(changedBy(sessionFact))
    }
    return () => {
      this.titleRevision = titleRevision
      this.sessionRevision = sessionRevision
      for (const [key, value] of this.operations) {
        if (value === null) {
          this.rows.delete(key)
        } else {
          this.rows.set(key, value)
        }
      }
      this.pending = null
      if (this.operations.length > 0) {
        this.operations = []
      }
      if (this.moved.size > 0) {
        this.moved.clear()
      }
      this.refreshes = EMPTY_REFRESHES
    }
  }

  capture(): AcceptedAgentStatuses {
    const captured = new AcceptedAgentStatuses(
      new Map(this),
      this.projection.capture(),
      this.sleepingCount
    )
    captured.titleRevision = this.titleRevision
    captured.sessionRevision = this.sessionRevision
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
