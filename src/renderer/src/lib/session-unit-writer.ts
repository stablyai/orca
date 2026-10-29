import { copySessionRecord } from '../../../shared/session-record-edit'

import type { WorkspaceSessionPatch } from '../../../shared/workspace-session-state-types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import {
  isSessionMapField,
  sessionMap,
  type SessionMapDeltas,
  type SessionMapField
} from '../../../shared/session-change-set'

import type { HostPersistenceState } from './workspace-session-host-persistence'
import type { SessionProjectionUpdate } from './session-unit-projection'

import { SessionWriteBaselines, unitId, same, type Unit } from './session-write-baselines'
export class SessionUnitWriter extends SessionWriteBaselines {
  dispose(): void {
    this.epoch++
  }
  async write(update: SessionProjectionUpdate, state: HostPersistenceState): Promise<void> {
    const { routing, epoch, slices } = this.routeUpdate(update, state)
    const patches = new Map<ExecutionHostId, WorkspaceSessionPatch>()
    const captures = new Map<ExecutionHostId, Map<string, Unit | undefined>>()
    const ensure = (host: ExecutionHostId): WorkspaceSessionPatch => {
      let patch = patches.get(host)
      if (!patch) {
        patch = {}
        patches.set(host, patch)
      }
      return patch
    }
    const edit = (unit: Unit, value: unknown): void => {
      const deltas: SessionMapDeltas = (ensure(unit.host).mapDeltas ??= {})
      const delta = deltas[unit.field] ?? { set: {}, remove: [] }
      if (value === undefined) {
        delta.remove = [...(delta.remove ?? []), unit.key]
      } else {
        Object.assign((delta.set ??= {}), { [unit.key]: value })
      }
      Object.assign(deltas, { [unit.field]: delta })
      const capture = captures.get(unit.host) ?? new Map<string, Unit | undefined>()
      capture.set(unitId(unit.field, unit.key), value === undefined ? undefined : unit)
      captures.set(unit.host, capture)
    }
    for (const id of this.pending) {
      const priors = this.acknowledged.get(id),
        next = this.desired.get(id)
      let dirty = false
      for (const prior of priors?.values() ?? []) {
        if (!next?.has(prior.host)) {
          edit(prior, undefined)
          dirty = true
        }
      }
      for (const unit of next?.values() ?? []) {
        if (!same(priors?.get(unit.host)?.value, unit.value)) {
          edit(unit, unit.value)
          dirty = true
        }
      }
      if (!dirty) {
        this.pending.delete(id)
      }
    }
    if (update.patch.activeWorktreeIdsOnShutdown !== undefined) {
      const active = new Set(update.patch.activeWorktreeIdsOnShutdown)
      for (const owner of update.workspaces) {
        this.pendingWorkspaces.add(owner)
        if (active.has(owner)) {
          this.workspaces.set(owner, routing.hostIdByWorktreeId(owner))
        } else {
          this.workspaces.delete(owner)
        }
      }
    }
    for (const [hostKey, slice] of Object.entries(slices)) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the splitter creates only execution-host partition keys.
      const host = hostKey as ExecutionHostId
      const desired = { ...this.desiredGlobals.get(host) }
      for (const [field, value] of Object.entries(slice ?? {})) {
        if (
          isSessionMapField(field) ||
          field === 'activeWorktreeIdsOnShutdown' ||
          field === 'activeConnectionIdsAtShutdown'
        ) {
          continue
        }
        Object.assign(desired, { [field]: value })
      }
      this.desiredGlobals.set(host, desired)
      this.pendingGlobals.add(host)
    }
    for (const host of this.pendingGlobals) {
      for (const [field, value] of Object.entries(this.desiredGlobals.get(host) ?? {})) {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: desired globals are a workspace session patch.
        const name = field as keyof WorkspaceSessionPatch
        if (!same(this.globals.get(host)?.[name], value)) {
          Object.assign(ensure(host), { [field]: value })
        }
      }
    }
    const memberships = new Map<ExecutionHostId, Map<string, boolean>>()
    const membership = (host: ExecutionHostId, id: string, present: boolean): void => {
      const delta = ((ensure(host).membershipDeltas ??= {}).activeWorktreeIdsOnShutdown ??= {
        add: [],
        remove: []
      })
      if (present) {
        delta.add = [...(delta.add ?? []), id]
      } else {
        delta.remove = [...(delta.remove ?? []), id]
      }
      const capture = memberships.get(host) ?? new Map<string, boolean>()
      capture.set(id, present)
      memberships.set(host, capture)
    }
    for (const id of this.pendingWorkspaces) {
      const before = this.workspaceBaseline.get(id) ?? new Set<ExecutionHostId>()
      const next = this.workspaces.get(id)
      for (const host of before) {
        if (host !== next) {
          membership(host, id, false)
        }
      }
      if (next && !before.has(next)) {
        membership(next, id, true)
      }
      if ((!next && !before.size) || (next && before.size === 1 && before.has(next))) {
        this.pendingWorkspaces.delete(id)
      }
    }
    const connectionChanges =
      update.connections ??
      (update.full
        ? new Map(
            [
              ...new Set([
                ...this.connections,
                ...(update.patch.activeConnectionIdsAtShutdown ?? [])
              ])
            ].map((id) => [id, Boolean(update.patch.activeConnectionIdsAtShutdown?.includes(id))])
          )
        : new Map<string, boolean>())
    for (const [id, present] of connectionChanges) {
      if (present) {
        this.connections.add(id)
      } else {
        this.connections.delete(id)
      }
      this.pendingConnections.add(id)
    }
    const connectionCapture = new Map<string, boolean>()
    for (const id of this.pendingConnections) {
      const next = this.connections.has(id)
      if (next === this.connectionBaseline.has(id)) {
        this.pendingConnections.delete(id)
        continue
      }
      const delta = ((ensure(LOCAL_EXECUTION_HOST_ID).membershipDeltas ??=
        {}).activeConnectionIdsAtShutdown ??= { add: [], remove: [] })
      if (next) {
        delta.add = [...(delta.add ?? []), id]
      } else {
        delta.remove = [...(delta.remove ?? []), id]
      }
      connectionCapture.set(id, next)
    }
    if (update.full) {
      for (const [hostKey, slice] of Object.entries(slices)) {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the splitter emits execution-host keys.
        const host = hostKey as ExecutionHostId
        const fields =
          this.fullFields.get(host) ?? new Map<SessionMapField, Readonly<Record<string, unknown>>>()
        for (const field of update.keys.keys()) {
          if (slice && Object.hasOwn(slice, field)) {
            fields.set(field, sessionMap(slice, field) ?? {})
          }
        }
        this.fullFields.set(host, fields)
      }
    }
    const fullCaptures = new Map<
      ExecutionHostId,
      ReadonlyMap<SessionMapField, Readonly<Record<string, unknown>>>
    >()
    for (const [host, fields] of this.fullFields) {
      // A failed full boundary retains its complete clear/reorder obligation until applied.
      for (const field of fields.keys()) {
        const delta = patches.get(host)?.mapDeltas?.[field]
        if (delta) {
          fields.set(field, copySessionRecord(fields.get(field), delta.set, delta.remove))
        }
      }
      const patch = ensure(host)
      for (const [field, values] of fields) {
        Object.assign(patch, { [field]: values })
        if (patch.mapDeltas) {
          delete patch.mapDeltas[field]
        }
      }
      if (patch.mapDeltas && !Object.keys(patch.mapDeltas).length) {
        delete patch.mapDeltas
      }
      fullCaptures.set(host, new Map(fields))
    }
    const globalCaptures = new Map(this.desiredGlobals)
    const results = await Promise.allSettled(
      [...patches].map(async ([host, patch]) => {
        if (!update.full && !fullCaptures.has(host)) {
          patch.mapDeltas ??= {}
        }
        await this.apply(host, patch)
        if (epoch !== this.epoch) {
          return
        }
        for (const [id, unit] of captures.get(host) ?? []) {
          const hosts = this.acknowledged.get(id) ?? new Map<ExecutionHostId, Unit>()
          if (unit) {
            hosts.set(host, unit)
          } else {
            hosts.delete(host)
          }
          if (hosts.size) {
            this.acknowledged.set(id, hosts)
          } else {
            this.acknowledged.delete(id)
          }
          const desired = this.desired.get(id)
          if (
            (desired?.size ?? 0) === hosts.size &&
            [...hosts].every(([destination, value]) =>
              same(desired?.get(destination)?.value, value.value)
            )
          ) {
            this.pending.delete(id)
          }
        }
        for (const [field, values] of fullCaptures.get(host) ?? []) {
          if (this.fullFields.get(host)?.get(field) === values) {
            this.fullFields.get(host)?.delete(field)
          }
        }
        if (!this.fullFields.get(host)?.size) {
          this.fullFields.delete(host)
        }
        const globals = globalCaptures.get(host)
        if (globals) {
          this.globals.set(host, globals)
          this.pendingGlobals.delete(host)
        }
        for (const [id, present] of memberships.get(host) ?? []) {
          const before = this.workspaceBaseline.get(id) ?? new Set<ExecutionHostId>()
          if (present) {
            before.add(host)
          } else {
            before.delete(host)
          }
          if (before.size) {
            this.workspaceBaseline.set(id, before)
          } else {
            this.workspaceBaseline.delete(id)
          }
          const desired = this.workspaces.get(id)
          if ((!desired && !before.size) || (desired && before.size === 1 && before.has(desired))) {
            this.pendingWorkspaces.delete(id)
          }
        }
        if (patch.membershipDeltas?.activeConnectionIdsAtShutdown) {
          for (const [id, present] of connectionCapture) {
            if (present) {
              this.connectionBaseline.add(id)
            } else {
              this.connectionBaseline.delete(id)
            }
            this.pendingConnections.delete(id)
          }
        }
      })
    )
    const failed = results.find((result) => result.status === 'rejected')
    if (failed) {
      throw failed.reason
    }
  }
}
