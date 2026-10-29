import {
  SESSION_SOURCE_FIELDS,
  SESSION_SOURCE_KINDS,
  type SessionSourceDiscovery,
  type SessionSourceField,
  type SessionSourcePresence,
  type SessionSourceKind
} from '../lib/session-source-fields'
import { SessionSourceSequence } from './session-source-sequence'

import { SessionSourceReceipts } from '../lib/session-source-receipts'
import type { AppState } from './types'
import type {
  SourceKey,
  RecordKey,
  Entry,
  OrdinarySourcePartial,
  SessionSourcePartial,
  SourceWriteData
} from './session-source-write-types'
export type * from './session-source-write-types'

type FullSourceBoundary = 'hydration' | 'catalog' | 'order' | 'unload'

type SourceEntry = { present: boolean; value: unknown }
type SourceEntries = Map<string, unknown> | Readonly<Record<string, unknown>> | undefined

class SourceWrite<S> {
  readonly sourceWrite = true
  readonly #data: { partial: Readonly<Partial<S>>; receipt: SessionSourceDiscovery }
  constructor(partial: Partial<S>, receipt: SessionSourceDiscovery) {
    this.#data = Object.freeze({
      partial: Object.freeze({ ...partial }),
      receipt: Object.freeze(receipt)
    })
    Object.freeze(this)
  }
  static unwrap<S>(write: SourceWrite<S>) {
    return write.#data
  }
}
export type SessionSourceWrite<S> = SourceWrite<S>

/** Only the setter, middleware and batch boundary may access accepted payloads. */
export function unwrapSessionSourceWrite<S>(write: SessionSourcePartial<S>): SourceWriteData<S> {
  return write instanceof SourceWrite
    ? SourceWrite.unwrap(write)
    : { partial: write, receipt: undefined }
}

/** Values and addresses are emitted by the same operation; no source ancestry is retained. */
export class SessionSourceEdit<S extends object> {
  private readonly partial: Partial<S> = {}
  private readonly changes = new Map<SessionSourceField, Set<string> | null>()
  private readonly copied = new Set<SessionSourceField>()
  private readonly baseEntries = new Map<SessionSourceField, Map<string, SourceEntry>>()
  private readonly presence = new Map<SessionSourceField, Map<string, SessionSourcePresence>>()
  private full = false
  private fullBoundary: SessionSourceDiscovery['fullBoundary']
  private readonly sequences: NonNullable<SessionSourceDiscovery['sequences']> = {}

  constructor(private readonly source: S) {}

  read<F extends SourceKey<S>>(field: F): S[F] {
    return Object.hasOwn(this.partial, field) ? this.partial[field]! : this.source[field]
  }

  get changed(): boolean {
    return this.changes.size !== 0
  }

  view(other: OrdinarySourcePartial<S> = {}): S {
    return Object.assign({}, this.source, other, this.partial)
  }

  private mark(field: SourceKey<S>, key: string): void {
    if (this.changes.get(field) === null) {
      return
    }
    const keys = this.changes.get(field) ?? new Set<string>()
    keys.add(key)
    this.changes.set(field, keys)
  }

  private current<F extends RecordKey<S>>(field: F) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: RecordKey admits only string-keyed Records and Maps, including optional ones.
    return (
      Object.hasOwn(this.partial, field) ? this.partial[field] : this.source[field]
    ) as SourceEntries
  }

  has<F extends RecordKey<S>>(field: F, key: string): boolean {
    const current = this.current(field)
    return current instanceof Map ? current.has(key) : Object.hasOwn(current ?? {}, key)
  }

  private baseEntry<F extends RecordKey<S>>(field: F, key: string) {
    const entries = this.baseEntries.get(field) ?? new Map<string, SourceEntry>()
    this.baseEntries.set(field, entries)
    let entry = entries.get(key)
    if (!entry) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: RecordKey admits only the source collection domain.
      const source = this.source[field] as SourceEntries
      entry = {
        present: source instanceof Map ? source.has(key) : Object.hasOwn(source ?? {}, key),
        value: source instanceof Map ? source.get(key) : source?.[key]
      }
      entries.set(key, entry)
    }
    return entry
  }

  entry<F extends RecordKey<S>>(field: F, key: string): Entry<S, F> | undefined {
    const current = this.current(field)
    const value = Object.hasOwn(this.partial, field)
      ? current instanceof Map
        ? current.get(key)
        : current?.[key]
      : this.baseEntry(field, key).value
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the field/key pair admits only that Record or Map's entry type.
    return value as Entry<S, F> | undefined
  }

  private record<F extends RecordKey<S>>(field: F): Map<string, unknown> | Record<string, unknown> {
    if (!this.copied.has(field)) {
      const source = this.current(field)
      Object.assign(this.partial, {
        [field]: source instanceof Map ? new Map(source) : { ...source }
      })
      this.copied.add(field)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: record fields are copied above as a Map or plain Record and never replaced here.
    return this.partial[field] as Map<string, unknown> | Record<string, unknown>
  }

  set<F extends RecordKey<S>>(field: F, key: string, value: Entry<S, F> | undefined): this {
    const current = this.current(field)
    const base = this.baseEntry(field, key)
    const edited = Object.hasOwn(this.partial, field)
    const present = edited
      ? current instanceof Map
        ? current.has(key)
        : Object.hasOwn(current ?? {}, key)
      : base.present
    const prior = edited ? (current instanceof Map ? current.get(key) : current?.[key]) : base.value
    if (present && prior === value) {
      return this
    }
    const source = this.source[field]
    if (
      !present &&
      this.changes.get(field)?.has(key) &&
      (source instanceof Map ? source.has(key) : Object.hasOwn(source ?? {}, key))
    ) {
      this.full = true
      this.fullBoundary = 'order'
    }
    this.transition(field, key, present, true)
    const record = this.record(field)
    if (record instanceof Map) {
      record.set(key, value)
    } else {
      Object.defineProperty(record, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true
      })
    }
    this.mark(field, key)
    return this
  }

  remove<F extends RecordKey<S>>(field: F, key: string): this {
    this.baseEntry(field, key)
    if (!this.has(field, key)) {
      return this
    }
    this.transition(field, key, true, false)
    const record = this.record(field)
    if (record instanceof Map) {
      record.delete(key)
    } else {
      Reflect.deleteProperty(record, key)
    }
    this.mark(field, key)
    return this
  }

  removeKeys<F extends RecordKey<S>>(field: F, keys: Iterable<string>): this {
    for (const key of keys) {
      this.remove(field, key)
    }
    return this
  }

  private transition(field: SourceKey<S>, key: string, before: boolean, after: boolean): void {
    const entries = this.presence.get(field) ?? new Map<string, SessionSourcePresence>()
    const prior = entries.get(key)
    if (prior && !prior.after && after) {
      this.full = true
      this.fullBoundary = 'order'
    }
    entries.set(key, { before: prior?.before ?? before, after })
    this.presence.set(field, entries)
  }

  replace<F extends SourceKey<S>>(field: F, value: S[F], boundary: FullSourceBoundary): this {
    Object.assign(this.partial, { [field]: value })
    this.copied.delete(field)
    this.changes.set(field, null)
    this.full = true
    this.fullBoundary = boundary === 'order' ? 'order' : 'replacement'
    return this
  }

  sequence<F extends Extract<SourceKey<S>, SessionSourceKind<'sequence'>>>(field: F) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the exhaustive field-kind table permits only arrays in the sequence domain.
    const rows = this.read(field) as readonly SequenceRow<S, F>[]
    return new SessionSourceSequence(
      rows,
      (row) => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: openFiles groups by owner; the three catalogs group by entity ID.
        const identity = row as { id: string; worktreeId: string }
        return field === 'openFiles' ? identity.worktreeId : identity.id
      },
      (rows, groups, keys, reordered, presence, preserveSource) => {
        if (preserveSource) {
          return this
        }
        Object.assign(this.partial, { [field]: rows })
        const selected = this.changes.get(field)
        if (selected !== null) {
          const union = new Set([...(selected ?? []), ...keys])
          this.changes.set(field, union)
          Reflect.set(
            this.sequences,
            field,
            new Map([...union].map((key) => [key, groups.get(key) ?? []]))
          )
        }
        for (const [key, change] of presence) {
          this.transition(field, key, change.before, change.after)
        }
        if (field !== 'openFiles' && reordered) {
          this.full = true
          this.fullBoundary = 'order'
        }
        return this
      }
    )
  }

  finish(other: OrdinarySourcePartial<S> = {}): SessionSourceWrite<S> {
    this.copied.clear()
    for (const [field, keys] of this.changes) {
      if (!keys || SESSION_SOURCE_KINDS[field] !== 'keyed') {
        continue
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: keyed changes were admitted only by this edit's RecordKey methods.
      const after = this.current(field as RecordKey<S>)
      for (const key of keys) {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: set/remove capture the base entry before admitting a keyed edit.
        const base = this.baseEntries.get(field)?.get(key) as SourceEntry
        const nextPresent = after instanceof Map ? after.has(key) : Object.hasOwn(after ?? {}, key)
        const nextValue = after instanceof Map ? after.get(key) : after?.[key]
        if (base.present === nextPresent && base.value === nextValue) {
          keys.delete(key)
        }
      }
    }
    return new SourceWrite<S>(Object.assign({}, other, this.partial), {
      changes: new Map(
        [...this.changes].map(([field, keys]) => [field, keys === null ? null : new Set(keys)])
      ),
      full: this.full,
      fullBoundary: this.fullBoundary,
      sequences: Object.fromEntries(
        Object.entries(this.sequences).map(([field, groups]) => [
          field,
          new Map<string, readonly unknown[]>(groups)
        ])
      ),
      presence: new Map([...this.presence].map(([field, entries]) => [field, new Map(entries)]))
    })
  }
}

export function editSessionSource<S extends object>(state: S): SessionSourceEdit<S> {
  return new SessionSourceEdit(state)
}

type SequenceRow<S, F extends keyof S> = S[F] extends readonly (infer V)[] ? V : never

export function replaceSessionSourceFields<S extends object>(
  partial: Partial<S>,
  boundary: FullSourceBoundary
): SessionSourceWrite<S> {
  return new SourceWrite(partial, {
    changes: new Map(SESSION_SOURCE_FIELDS.map((field) => [field, null])),
    full: true,
    fullBoundary: boundary === 'order' ? 'order' : 'replacement'
  })
}

/** Composition accepts only already-authorized writes; overlap is reserved for sequential middleware. */
export function composeSessionSourceWrites<S>(
  writes: SessionSourcePartial<S>[],
  middlewareChain = false,
  roots?: { before: AppState; after: AppState }
): SessionSourceWrite<S> {
  const receipts = new SessionSourceReceipts(),
    fields = new Set<string>()
  const partial: Partial<S> = {}
  for (const write of writes) {
    const data = unwrapSessionSourceWrite(write)
    for (const field of data.receipt?.changes.keys() ?? []) {
      if (
        import.meta.env.DEV &&
        !middlewareChain &&
        SESSION_SOURCE_KINDS[field] === 'keyed' &&
        fields.has(field)
      ) {
        throw new Error(`Composed source writes overlap: ${field}`)
      }
      fields.add(field)
    }
    if (data.receipt) {
      receipts.add(data.receipt)
    }
    Object.assign(partial, data.partial)
  }
  return new SourceWrite(
    partial,
    roots ? receipts.take(roots.before, roots.after) : receipts.snapshot()
  )
}
