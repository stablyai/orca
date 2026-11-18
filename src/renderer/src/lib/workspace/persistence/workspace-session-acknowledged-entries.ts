import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { structuralValuesEqual } from '../../../../../shared/collections/structural-value-equality'
import { isWorkspaceSessionRecord } from '../../../../../shared/workspace-session/workspace-session-host-records'
import type { WorkspaceSessionEntriesPatch } from '../../../../../shared/workspace-session/workspace-session-entries-patch'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'

type SessionField = keyof WorkspaceSessionState

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
  private readonly byHost = new Map<ExecutionHostId, Map<SessionField, unknown>>()

  diff(hostId: ExecutionHostId, slice: WorkspaceSessionState): WorkspaceSessionEntriesDiff {
    const acknowledged = this.byHost.get(hostId)
    const patch: WorkspaceSessionEntriesPatch = { fields: {}, entries: {} }
    const fields = Object.keys(slice) as SessionField[]
    for (const field of fields) {
      const value = slice[field]
      if (!acknowledged?.has(field)) {
        ;(patch.fields as Record<string, unknown>)[field] = value
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
          patch.entries[field] = { set, remove }
        }
        continue
      }
      if (!sameValue(previous, value)) {
        ;(patch.fields as Record<string, unknown>)[field] = value
      }
    }
    return {
      patch,
      acknowledge: () => {
        let host = this.byHost.get(hostId)
        if (!host) {
          host = new Map()
          this.byHost.set(hostId, host)
        }
        for (const field of fields) {
          host.set(field, slice[field])
        }
      }
    }
  }

  /** Main's copy can't be assumed after a failed, fenced or whole-partition write: send whole fields. */
  forget(hostId?: ExecutionHostId): void {
    if (hostId === undefined) {
      this.byHost.clear()
    } else {
      this.byHost.delete(hostId)
    }
  }
}

export function isEmptyWorkspaceSessionEntriesPatch(patch: WorkspaceSessionEntriesPatch): boolean {
  return Object.keys(patch.fields).length === 0 && Object.keys(patch.entries).length === 0
}
