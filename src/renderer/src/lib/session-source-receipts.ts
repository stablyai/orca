import type { AppState } from '../store/types'
import {
  SESSION_SOURCE_KINDS,
  type SessionSourceDiscovery,
  type SessionSourceField,
  type SessionSourcePresence,
  type SessionSourceSequences,
  type SessionSourceKind,
  type SessionSequenceField
} from './session-source-fields'

/** Source coalescing is independent of delivery ACKs; deletion history retains native order. */
export class SessionSourceReceipts {
  private readonly changes = new Map<SessionSourceField, Set<string> | null>()
  private readonly sequences: SessionSourceSequences = {}
  private readonly presence = new Map<SessionSourceField, Map<string, SessionSourcePresence>>()
  private full = false
  private fullBoundary: SessionSourceDiscovery['fullBoundary']

  get size(): number {
    return this.changes.size
  }

  add(receipt: SessionSourceDiscovery): void {
    this.full ||= receipt.full
    this.fullBoundary = receipt.fullBoundary ?? this.fullBoundary
    for (const [field, entries] of receipt.presence ?? []) {
      const pending = this.presence.get(field) ?? new Map<string, SessionSourcePresence>()
      this.presence.set(field, pending)
      for (const [key, transition] of entries) {
        const prior = pending.get(key)
        if (prior && !prior.after && transition.after) {
          this.full = true
          this.fullBoundary = 'order'
        }
        pending.set(key, { before: prior?.before ?? transition.before, after: transition.after })
      }
    }
    for (const [field, keys] of receipt.changes) {
      const prior = this.changes.get(field)
      if (prior === null) {
        continue
      }
      if (keys === null) {
        this.changes.set(field, null)
      } else {
        const selected = prior ?? new Set<string>()
        for (const key of keys) {
          selected.add(key)
        }
        this.changes.set(field, selected)
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: receipt sequences use only the exhaustive sequence field domain.
    for (const field of Object.keys(receipt.sequences ?? {}) as SessionSequenceField[]) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: sequence properties are restricted to the exhaustive sequence field domain.
      const incoming = receipt.sequences![field] as ReadonlyMap<string, unknown[]>
      // SAFETY: each sequence field retains its own row domain across accumulator writes.
      const pending =
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each sequence field retains its own row domain across accumulator writes.
        (this.sequences[field] as Map<string, unknown[]> | undefined) ??
        new Map<string, unknown[]>()
      for (const [key, rows] of incoming ?? []) {
        pending.set(key, rows)
      }
      Object.assign(this.sequences, { [field]: pending })
    }
  }

  snapshot(): SessionSourceDiscovery {
    return {
      changes: new Map([...this.changes].map(([field, keys]) => [field, keys && new Set(keys)])),
      full: this.full,
      fullBoundary: this.fullBoundary,
      sequences: Object.fromEntries(
        Object.entries(this.sequences).map(([field, rows]) => [
          field,
          new Map<string, readonly unknown[]>(rows)
        ])
      ),
      presence: new Map([...this.presence].map(([field, entries]) => [field, new Map(entries)]))
    }
  }

  take(before: AppState, after: AppState): SessionSourceDiscovery {
    const receipt = this.snapshot()
    const changes = new Map<SessionSourceField, ReadonlySet<string> | null>()
    for (const [field, selected] of receipt.changes) {
      const prior = before[field],
        next = after[field]
      if (prior === next && Object.hasOwn(before, field) === Object.hasOwn(after, field)) {
        continue
      }
      if (!selected || SESSION_SOURCE_KINDS[field] !== 'keyed') {
        changes.set(field, selected)
        continue
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the field-kind branch above admits only keyed source collections.
      const name = field as SessionSourceKind<'keyed'>
      const oldEntries = before[name],
        newEntries = after[name]
      const keys = new Set<string>()
      for (const key of selected) {
        const oldPresent =
          oldEntries instanceof Map ? oldEntries.has(key) : Object.hasOwn(oldEntries ?? {}, key)
        const newPresent =
          newEntries instanceof Map ? newEntries.has(key) : Object.hasOwn(newEntries ?? {}, key)
        const oldValue = oldEntries instanceof Map ? oldEntries.get(key) : oldEntries?.[key]
        const newValue = newEntries instanceof Map ? newEntries.get(key) : newEntries?.[key]
        if (oldPresent !== newPresent || oldValue !== newValue) {
          keys.add(key)
        }
      }
      changes.set(field, keys)
    }
    return { ...receipt, changes }
  }
}
