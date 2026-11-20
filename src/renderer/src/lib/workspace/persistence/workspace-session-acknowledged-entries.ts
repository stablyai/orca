import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { structuralValuesEqual } from '../../../../../shared/collections/structural-value-equality'
import { isWorkspaceSessionRecord } from '../../../../../shared/workspace-session/workspace-session-host-records'
import type {
  WorkspaceSessionEntriesPatch,
  WorkspaceSessionFieldEntryChanges
} from '../../../../../shared/workspace-session/workspace-session-entries-patch'
import type { WorkspaceSessionPatch } from '../../../../../shared/workspace-session/workspace-session-state-types'

export type WorkspaceSessionEntriesDiff = {
  patch: WorkspaceSessionEntriesPatch
  /** Record this slice as what main now holds for its fields; call only after main accepted it. */
  acknowledge: () => void
  /** Main skipped the slice without storing any of it: drop the values sending it claimed. */
  retract: () => void
}

type Claim = { field: string; key: string; value: unknown }

// Keyed fields other writers also save into, so a write must never replace them whole once this
// window has saved keys there: restart reattaches the relay ids in remoteSessionIdsByTabId.
const KEY_SCOPED_FIELDS: ReadonlySet<string> = new Set(['remoteSessionIdsByTabId'])

function sameValue(previous: unknown, next: unknown): boolean {
  return previous === next || structuralValuesEqual(previous, next)
}

/** What main last acknowledged from this window, per host partition and field. A field main hasn't
 *  acknowledged goes whole (a key-scoped one always goes as entries); after that only changed keys
 *  travel. */
export class AcknowledgedWorkspaceSessionEntries {
  private readonly byHost = new Map<ExecutionHostId, Map<string, unknown>>()
  // A whole-session write replaces main's copy; an acknowledgement that started before it is stale.
  private generation = 0
  // Per key-scoped field and host, the keys this window speaks for and every value it may have left
  // there: hydrated or acknowledged (one, certain) or sent and snapshotted (added, unconfirmed). A key is
  // dropped only when main acknowledges its removal; failed and whole-session writes keep it all. Removals
  // carry the values, so main keeps a key another writer has since replaced.
  private readonly ownedKeys = new Map<string, Map<ExecutionHostId, Map<string, unknown[]>>>()

  constructor(private readonly keyScopedFields: ReadonlySet<string> = KEY_SCOPED_FIELDS) {}

  diff(hostId: ExecutionHostId, slice: WorkspaceSessionPatch): WorkspaceSessionEntriesDiff {
    const acknowledged = this.byHost.get(hostId)
    const generation = this.generation
    const patch: WorkspaceSessionEntriesPatch = { fields: {}, entries: {} }
    const sliceFields: Record<string, unknown> = slice
    const fields = Object.keys(slice)
    const claims: Claim[] = []
    for (const field of fields) {
      const value = sliceFields[field]
      const record =
        this.keyScopedFields.has(field) && isWorkspaceSessionRecord(value) ? value : undefined
      if (!acknowledged?.has(field)) {
        if (record) {
          // Other writers hold keys in this field; whole would erase them. Remove only this window's.
          const owned = this.ownedKeys.get(field)?.get(hostId)
          const remove = owned ? [...owned.keys()].filter((key) => !Object.hasOwn(record, key)) : []
          Reflect.set(
            patch.entries,
            field,
            this.scopedChanges(field, hostId, { ...record }, remove)
          )
          this.own(field, hostId, record, 'possible', claims)
        } else {
          Reflect.set(patch.fields, field, value)
        }
        continue
      }
      const previous = acknowledged.get(field)
      if (isWorkspaceSessionRecord(value) && isWorkspaceSessionRecord(previous)) {
        const set: Record<string, unknown> = {}
        let changed = false
        for (const [key, entry] of Object.entries(value)) {
          if (!Object.hasOwn(previous, key) || !sameValue(previous[key], entry)) {
            set[key] = entry
            changed = true
          }
        }
        const remove = Object.keys(previous).filter((key) => !Object.hasOwn(value, key))
        if (changed || remove.length > 0) {
          if (record) {
            Reflect.set(patch.entries, field, this.scopedChanges(field, hostId, set, remove))
            this.own(field, hostId, set, 'possible', claims)
          } else {
            Reflect.set(patch.entries, field, { set, remove })
          }
        }
        continue
      }
      if (!sameValue(previous, value)) {
        Reflect.set(patch.fields, field, value)
      }
    }
    return {
      patch,
      acknowledge: () => {
        if (generation !== this.generation) {
          return
        }
        let host = this.byHost.get(hostId)
        if (!host) {
          host = new Map()
          this.byHost.set(hostId, host)
        }
        for (const field of fields) {
          host.set(field, sliceFields[field])
        }
        for (const [field, changes] of Object.entries(patch.entries)) {
          if (!changes || !this.keyScopedFields.has(field)) {
            continue
          }
          this.own(field, hostId, changes.set, 'stored')
          const owned = this.ownedKeys.get(field)?.get(hostId)
          for (const key of changes.remove) {
            owned?.delete(key)
          }
        }
      },
      retract: () => {
        // A snapshot since may carry the same values to main, so they stay possible.
        if (generation !== this.generation) {
          return
        }
        for (const { field, key, value } of claims) {
          const owned = this.ownedKeys.get(field)?.get(hostId)
          const values = owned?.get(key)?.filter((known) => !sameValue(known, value))
          if (values?.length) {
            owned?.set(key, values)
          } else {
            owned?.delete(key)
          }
        }
      }
    }
  }

  private scopedChanges(
    field: string,
    hostId: ExecutionHostId,
    set: Record<string, unknown>,
    remove: string[]
  ): WorkspaceSessionFieldEntryChanges {
    const owned = this.ownedKeys.get(field)?.get(hostId)
    if (!owned || remove.length === 0) {
      return { set, remove }
    }
    const removeIfStored: Record<string, unknown[]> = {}
    for (const key of remove) {
      const values = owned.get(key)
      if (values) {
        removeIfStored[key] = [...values]
      }
    }
    return { set, remove, removeIfStored }
  }

  /** Record `record`'s keys as this window's: 'stored' when main is known to hold these values.
   *  Values newly made possible go to `claims`. */
  private own(
    field: string,
    hostId: ExecutionHostId,
    record: Record<string, unknown>,
    certainty: 'stored' | 'possible',
    claims?: Claim[]
  ): void {
    let byHost = this.ownedKeys.get(field)
    if (!byHost) {
      byHost = new Map()
      this.ownedKeys.set(field, byHost)
    }
    let owned = byHost.get(hostId)
    if (!owned) {
      owned = new Map()
      byHost.set(hostId, owned)
    }
    for (const key in record) {
      const value = record[key]
      const values = owned.get(key)
      if (certainty === 'stored') {
        owned.set(key, [value])
        continue
      }
      if (values?.some((known) => sameValue(known, value))) {
        continue
      }
      if (values) {
        values.push(value)
      } else {
        owned.set(key, [value])
      }
      claims?.push({ field, key, value })
    }
  }

  /** Keys read from a partition (`stored`), or carried by a whole-session snapshot main may not get. */
  ownSavedKeys(
    hostId: ExecutionHostId,
    slice: WorkspaceSessionPatch,
    certainty: 'stored' | 'possible'
  ): void {
    const sliceFields: Record<string, unknown> = slice
    for (const field of this.keyScopedFields) {
      const value = sliceFields[field]
      if (isWorkspaceSessionRecord(value)) {
        this.own(field, hostId, value, certainty)
      }
    }
  }

  /** Hosts holding keys of key-scoped `field` that this window saved, acknowledged or since rejected. */
  hostsHoldingEntries(field: string): readonly ExecutionHostId[] {
    const hostIds: ExecutionHostId[] = []
    for (const [hostId, keys] of this.ownedKeys.get(field) ?? []) {
      if (keys.size > 0) {
        hostIds.push(hostId)
      }
    }
    return hostIds
  }

  /** Main's copy can't be assumed after a failed, fenced or whole-partition write: send whole fields. */
  forget(hostId?: ExecutionHostId, fields?: readonly string[]): void {
    if (hostId === undefined) {
      this.byHost.clear()
      this.generation += 1
    } else if (fields) {
      const host = this.byHost.get(hostId)
      for (const field of fields) {
        host?.delete(field)
      }
    } else {
      this.byHost.delete(hostId)
    }
  }

  /** Drop hosts this window no longer routes to; forgetting a live one only makes its next write whole. */
  retainHosts(hostIds: ReadonlySet<ExecutionHostId>): void {
    for (const hostId of this.byHost.keys()) {
      if (!hostIds.has(hostId)) {
        this.byHost.delete(hostId)
      }
    }
    for (const byHost of this.ownedKeys.values()) {
      for (const hostId of byHost.keys()) {
        if (!hostIds.has(hostId)) {
          byHost.delete(hostId)
        }
      }
    }
  }
}

/** One window, one copy: the debounced writer diffs against it, and whole-session writes from this
 *  window (set, unload staging) clear it because they replace what main holds. */
export const windowAcknowledgedSessionEntries = new AcknowledgedWorkspaceSessionEntries()
