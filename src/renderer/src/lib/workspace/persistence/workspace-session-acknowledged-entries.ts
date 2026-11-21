import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { structuralValuesEqual } from '../../../../../shared/collections/structural-value-equality'
import { isWorkspaceSessionRecord } from '../../../../../shared/workspace-session/workspace-session-host-records'
import type { WorkspaceSessionEntriesPatch } from '../../../../../shared/workspace-session/workspace-session-entries-patch'
import type { WorkspaceSessionPatch } from '../../../../../shared/workspace-session/workspace-session-state-types'
import type { HostSessionRouting } from './workspace-session-host-routing'

export type WorkspaceSessionEntriesDiff = {
  patch: WorkspaceSessionEntriesPatch
  /** Record this slice as what main now holds for its fields; call only after main accepted it. */
  acknowledge: () => void
}

function sameValue(previous: unknown, next: unknown): boolean {
  return previous === next || structuralValuesEqual(previous, next)
}

/** Changed keys of worktree-keyed record fields, for a write that rebuilt only those keys. */
export type WorkspaceSessionFieldEntries = Record<string, Record<string, unknown>>

type SettledInput = { outputs: ReadonlySet<string>; hostIds: ReadonlySet<ExecutionHostId> }

/** Identifies one routing of workspaces to hosts; a new routing is a new object. */
type RoutingGeneration = HostSessionRouting

/** What main last acknowledged from this window, per host partition and field. A field main hasn't
 *  acknowledged goes whole; after that only the keys whose values changed travel. */
export class AcknowledgedWorkspaceSessionEntries {
  private readonly byHost = new Map<ExecutionHostId, Map<string, unknown>>()
  // A whole-session write replaces main's copy; an acknowledgement that started before it is stale.
  private generation = 0
  // Field records this class copied, so a keyed acknowledgement may set keys in them in place.
  private readonly owned = new WeakSet<Record<string, unknown>>()
  private forgets = 0
  // Inputs whose whole-path output main holds as this window built it, under `settledRouting`.
  private readonly settled = new Map<string, SettledInput>()
  private settledRouting: RoutingGeneration | null = null

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
        }
      }
    }
  }

  /** Only the given keys, against what main acknowledged. Null when a field isn't acknowledged for
   *  this host: then only a whole-path write can say what main holds. */
  diffEntries(
    hostId: ExecutionHostId,
    fieldEntries: WorkspaceSessionFieldEntries
  ): WorkspaceSessionEntriesDiff | null {
    const acknowledged = this.byHost.get(hostId)
    const forgets = this.forgets
    const patch: WorkspaceSessionEntriesPatch = { fields: {}, entries: {} }
    // Only changed keys are acknowledged: an unchanged field's baseline already matches main.
    const sent: [string, Record<string, unknown>][] = []
    for (const [field, values] of Object.entries(fieldEntries)) {
      const previous = acknowledged?.get(field)
      if (!isWorkspaceSessionRecord(previous)) {
        return null
      }
      const set: Record<string, unknown> = {}
      let changed = false
      for (const [key, entry] of Object.entries(values)) {
        if (!Object.hasOwn(previous, key) || !sameValue(previous[key], entry)) {
          set[key] = entry
          changed = true
        }
      }
      if (changed) {
        Reflect.set(patch.entries, field, { set, remove: [] })
        sent.push([field, set])
      }
    }
    return {
      patch,
      acknowledge: () => {
        const host = this.byHost.get(hostId)
        if (!host) {
          return
        }
        if (forgets !== this.forgets) {
          // A forget landed meanwhile (maybe another host's): main took these keys, but merging them
          // into a copy that may be stale is unsafe, so these fields go whole next time.
          for (const [field] of sent) {
            host.delete(field)
          }
          return
        }
        for (const [field, values] of sent) {
          const record = host.get(field)
          if (!isWorkspaceSessionRecord(record)) {
            continue
          }
          // Stored whole values are the sent slices; copy once rather than mutate a shared object.
          const owned = this.owned.has(record) ? record : { ...record }
          this.owned.add(owned)
          host.set(field, owned)
          Object.assign(owned, values)
        }
      }
    }
  }

  /** Taken before a whole-path write; `settle` ignores the write if anything was forgotten since. */
  settleMark(): number {
    return this.forgets
  }

  /** A whole-path write every host accepted unchanged: main now holds the output of `inputs`, so a
   *  later write that rebuilds only some keys of them may skip the rest under the same routing. */
  settle(
    mark: number,
    routing: RoutingGeneration,
    inputs: readonly string[],
    outputs: readonly string[],
    hostIds: ReadonlySet<ExecutionHostId>
  ): void {
    if (mark !== this.forgets) {
      return
    }
    if (routing !== this.settledRouting) {
      this.settled.clear()
      this.settledRouting = routing
    }
    const settled: SettledInput = { outputs: new Set(outputs), hostIds }
    for (const input of inputs) {
      this.settled.set(input, settled)
    }
  }

  /** A whole-path write is being sent: a settled input that also outputs one of its fields, to hosts
   *  this write skips, no longer matches main there (a global only reaches hosts given a slice). */
  supersede(outputs: readonly string[], hostIds: ReadonlySet<ExecutionHostId>): void {
    for (const [input, settled] of this.settled) {
      if (
        outputs.some((field) => settled.outputs.has(field)) &&
        [...settled.hostIds].some((hostId) => !hostIds.has(hostId))
      ) {
        this.settled.delete(input)
      }
    }
  }

  /** A write main may have taken only in part (a failed host, refused relay ids): keyed writes wait
   *  for the whole path to resend what it owes. */
  unsettle(): void {
    this.forgets += 1
    this.settled.clear()
  }

  /** Whether main holds the whole path's output for `inputs` under `routing`. */
  isSettled(routing: RoutingGeneration, inputs: readonly string[]): boolean {
    return routing === this.settledRouting && inputs.every((input) => this.settled.has(input))
  }

  /** Hosts the whole path wrote for `inputs`, or null when main may not hold their output. */
  settledHosts(routing: RoutingGeneration, inputs: readonly string[]): Set<ExecutionHostId> | null {
    if (routing !== this.settledRouting) {
      return null
    }
    const hostIds = new Set<ExecutionHostId>()
    for (const input of inputs) {
      const settled = this.settled.get(input)
      if (!settled) {
        return null
      }
      settled.hostIds.forEach((hostId) => hostIds.add(hostId))
    }
    return hostIds
  }

  /** Main's copy can't be assumed after a failed, fenced or whole-partition write: send whole fields. */
  forget(hostId?: ExecutionHostId, fields?: readonly string[]): void {
    this.forgets += 1
    if (fields) {
      for (const [input, settled] of this.settled) {
        if (fields.some((field) => settled.outputs.has(field))) {
          this.settled.delete(input)
        }
      }
    } else {
      this.settled.clear()
    }
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
        this.forget(hostId)
      }
    }
  }
}

/** One window, one copy: the debounced writer diffs against it, and whole-session writes from this
 *  window (set, unload staging) clear it because they replace what main holds. */
export const windowAcknowledgedSessionEntries = new AcknowledgedWorkspaceSessionEntries()
