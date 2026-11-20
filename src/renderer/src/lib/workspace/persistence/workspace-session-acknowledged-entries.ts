import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { structuralValuesEqual } from '../../../../../shared/collections/structural-value-equality'
import { isWorkspaceSessionRecord } from '../../../../../shared/workspace-session/workspace-session-host-records'
import type { WorkspaceSessionEntriesPatch } from '../../../../../shared/workspace-session/workspace-session-entries-patch'
import type { WorkspaceSessionPatch } from '../../../../../shared/workspace-session/workspace-session-state-types'

export type WorkspaceSessionEntriesDiff = {
  patch: WorkspaceSessionEntriesPatch
  /** Record this slice as what main now holds for its fields; call only after main accepted it. */
  acknowledge: () => void
}

// Keyed fields other writers also save into, so a write must never replace them whole once this
// window has saved keys there: restart reattaches the relay ids in remoteSessionIdsByTabId.
const KEY_SCOPED_FIELDS: ReadonlySet<string> = new Set(['remoteSessionIdsByTabId'])

function sameValue(previous: unknown, next: unknown): boolean {
  return previous === next || structuralValuesEqual(previous, next)
}

/** What main last acknowledged from this window, per host partition and field. A field main hasn't
 *  acknowledged goes whole (a key-scoped one goes as entries); after that only changed keys travel. */
export class AcknowledgedWorkspaceSessionEntries {
  private readonly byHost = new Map<ExecutionHostId, Map<string, unknown>>()
  // A whole-session write replaces main's copy; an acknowledgement that started before it is stale.
  private generation = 0
  // Keys of a key-scoped field this window saved per host. Unlike byHost they outlive failed and
  // whole-session writes, so a retried clear still removes only this window's keys.
  private readonly ownedKeys = new Map<string, Map<ExecutionHostId, ReadonlySet<string>>>()

  constructor(private readonly keyScopedFields: ReadonlySet<string> = KEY_SCOPED_FIELDS) {}

  diff(hostId: ExecutionHostId, slice: WorkspaceSessionPatch): WorkspaceSessionEntriesDiff {
    const acknowledged = this.byHost.get(hostId)
    const generation = this.generation
    const patch: WorkspaceSessionEntriesPatch = { fields: {}, entries: {} }
    const sliceFields: Record<string, unknown> = slice
    const fields = Object.keys(slice)
    for (const field of fields) {
      const value = sliceFields[field]
      if (!acknowledged?.has(field)) {
        const owned = this.ownedKeys.get(field)?.get(hostId)
        if (owned && isWorkspaceSessionRecord(value)) {
          // Another writer may hold keys in this field; whole would erase them.
          const remove = [...owned].filter((key) => !Object.hasOwn(value, key))
          Reflect.set(patch.entries, field, { set: { ...value }, remove })
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
          Reflect.set(patch.entries, field, { set, remove })
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
          this.noteOwnedKeys(hostId, field, sliceFields[field], false)
        }
      }
    }
  }

  private noteOwnedKeys(
    hostId: ExecutionHostId,
    field: string,
    value: unknown,
    keep: boolean
  ): void {
    if (!this.keyScopedFields.has(field) || !isWorkspaceSessionRecord(value)) {
      return
    }
    let byHost = this.ownedKeys.get(field)
    const keys = new Set(keep ? byHost?.get(hostId) : undefined)
    for (const key in value) {
      keys.add(key)
    }
    if (keys.size > 0) {
      byHost ??= new Map()
      this.ownedKeys.set(field, byHost)
      byHost.set(hostId, keys)
    } else {
      byHost?.delete(hostId)
    }
  }

  /** A whole-session snapshot replaces main's copy but may be vetoed: own its keys as well. */
  noteSnapshot(hostId: ExecutionHostId, slice: WorkspaceSessionPatch): void {
    const sliceFields: Record<string, unknown> = slice
    for (const field of this.keyScopedFields) {
      this.noteOwnedKeys(hostId, field, sliceFields[field], true)
    }
  }

  /** Hosts holding keys of key-scoped `field` that this window saved, acknowledged or since rejected. */
  hostsHoldingEntries(field: string): readonly ExecutionHostId[] {
    const byHost = this.ownedKeys.get(field)
    return byHost ? [...byHost.keys()] : []
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
