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

function sameValue(previous: unknown, next: unknown): boolean {
  return previous === next || structuralValuesEqual(previous, next)
}

/** What main last acknowledged from this window, per host partition and field. A field main hasn't
 *  acknowledged goes whole; after that only the keys whose values changed travel. */
export class AcknowledgedWorkspaceSessionEntries {
  private readonly byHost = new Map<ExecutionHostId, Map<string, unknown>>()
  // Keys main stored differently, per host and field: they go again even when the window's value didn't change.
  private readonly unsettled = new Map<ExecutionHostId, Map<string, Set<string>>>()
  // A whole-session write replaces main's copy; an acknowledgement that started before it is stale.
  private generation = 0

  diff(hostId: ExecutionHostId, slice: WorkspaceSessionPatch): WorkspaceSessionEntriesDiff {
    const acknowledged = this.byHost.get(hostId)
    const generation = this.generation
    const patch: WorkspaceSessionEntriesPatch = { fields: {}, entries: {} }
    const sliceFields: Record<string, unknown> = slice
    const fields = Object.keys(slice)
    for (const field of fields) {
      const value = sliceFields[field]
      if (!acknowledged?.has(field)) {
        Reflect.set(patch.fields, field, value)
        continue
      }
      const previous = acknowledged.get(field)
      if (isWorkspaceSessionRecord(value) && isWorkspaceSessionRecord(previous)) {
        const set: Record<string, unknown> = {}
        let changed = false
        const resend = this.unsettled.get(hostId)?.get(field)
        for (const [key, entry] of Object.entries(value)) {
          if (
            !Object.hasOwn(previous, key) ||
            resend?.has(key) ||
            !sameValue(previous[key], entry)
          ) {
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
        const unsettled = this.unsettled.get(hostId)
        for (const field of fields) {
          host.set(field, sliceFields[field])
          unsettled?.delete(field)
        }
      }
    }
  }

  /** Main's copy can't be assumed after a failed, fenced or whole-partition write: send whole fields. */
  forget(hostId?: ExecutionHostId, fields?: readonly string[]): void {
    if (hostId === undefined) {
      this.byHost.clear()
      this.unsettled.clear()
      this.generation += 1
    } else if (fields) {
      const host = this.byHost.get(hostId)
      const unsettled = this.unsettled.get(hostId)
      for (const field of fields) {
        host?.delete(field)
        unsettled?.delete(field)
      }
    } else {
      this.byHost.delete(hostId)
      this.unsettled.delete(hostId)
    }
  }

  /** Only these keys of a keyed field go again; main keeps its copy of the rest. */
  forgetEntries(
    hostId: ExecutionHostId,
    entries: Readonly<Record<string, readonly string[]>>
  ): void {
    const host = this.byHost.get(hostId)
    if (!host) {
      return
    }
    let unsettled = this.unsettled.get(hostId)
    for (const [field, keys] of Object.entries(entries)) {
      if (!isWorkspaceSessionRecord(host.get(field))) {
        host.delete(field)
        continue
      }
      if (!unsettled) {
        unsettled = new Map()
        this.unsettled.set(hostId, unsettled)
      }
      const resend = unsettled.get(field) ?? new Set<string>()
      for (const key of keys) {
        resend.add(key)
      }
      unsettled.set(field, resend)
    }
  }

  /** Drop hosts this window no longer routes to; forgetting a live one only makes its next write whole. */
  retainHosts(hostIds: ReadonlySet<ExecutionHostId>): void {
    for (const hostId of this.byHost.keys()) {
      if (!hostIds.has(hostId)) {
        this.byHost.delete(hostId)
        this.unsettled.delete(hostId)
      }
    }
  }
}

/** One window, one copy: the debounced writer diffs against it, and whole-session writes from this
 *  window (set, unload staging) clear it because they replace what main holds. */
export const windowAcknowledgedSessionEntries = new AcknowledgedWorkspaceSessionEntries()
