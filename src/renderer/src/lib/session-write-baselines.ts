import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { attachHostSessionShadow } from './workspace-session-host-contention'
import type { WorkspaceSessionApi } from '../../../preload/api/workspace-session-api'
import type {
  WorkspaceSessionState,
  WorkspaceSessionPatch
} from '../../../shared/workspace-session-state-types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import {
  applySessionMapDeltas,
  sessionMap,
  type SessionMapField
} from '../../../shared/session-change-set'
import { splitWorkspaceSessionByHost } from './workspace-session-host-split'
import {
  buildHostSessionRouting,
  fullyOwnedSessionHostIds,
  type HostPersistenceState
} from './workspace-session-host-persistence'
import type { SessionProjectionUpdate } from './session-unit-projection'
export type Unit = { field: SessionMapField; key: string; value: unknown; host: ExecutionHostId }
export const unitId = (field: string, key: string): string => JSON.stringify([field, key])
export const same = (left: unknown, right: unknown): boolean =>
  left === right || JSON.stringify(left) === JSON.stringify(right)
export class SessionWriteBaselines {
  protected readonly acknowledged = new Map<string, Map<ExecutionHostId, Unit>>()
  protected readonly desired = new Map<string, Map<ExecutionHostId, Unit>>()
  protected readonly parked = new Map<string, Map<ExecutionHostId, Unit>>()
  protected readonly fullFields = new Map<
    ExecutionHostId,
    Map<SessionMapField, Readonly<Record<string, unknown>>>
  >()
  protected readonly pending = new Set<string>()
  protected readonly globals = new Map<ExecutionHostId, WorkspaceSessionPatch>()
  protected readonly desiredGlobals = new Map<ExecutionHostId, WorkspaceSessionPatch>()
  protected readonly pendingGlobals = new Set<ExecutionHostId>()
  protected readonly workspaces = new Map<string, ExecutionHostId>()
  protected readonly workspaceBaseline = new Map<string, Set<ExecutionHostId>>()
  protected readonly pendingWorkspaces = new Set<string>()
  protected readonly pendingConnections = new Set<string>()
  protected readonly connections = new Set<string>()
  protected readonly connectionBaseline = new Set<string>()
  protected routing: ReturnType<typeof buildHostSessionRouting> | undefined
  protected routingState: HostPersistenceState | undefined
  protected epoch = 0
  constructor(
    private readonly api: Pick<WorkspaceSessionApi['session'], 'patch' | 'getWithGeneration'>
  ) {}
  protected async apply(host: ExecutionHostId, patch: WorkspaceSessionPatch): Promise<void> {
    const hostArg = host === LOCAL_EXECUTION_HOST_ID ? undefined : host
    let ack
    try {
      ack = await this.api.patch(patch, hostArg)
    } catch (error) {
      if (!this.api.getWithGeneration) {
        throw error
      }
      // A full compatibility retry starts from a fresh, generation-fenced partition.
      const fresh = await this.api.getWithGeneration(hostArg)
      const next = applySessionMapDeltas(fresh.session, patch.mapDeltas ?? {})
      const full: WorkspaceSessionPatch = { expectedPartitionGeneration: fresh.partitionGeneration }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: map delta keys are restricted to the session map field domain.
      for (const field of Object.keys(patch.mapDeltas ?? {}) as SessionMapField[]) {
        Object.assign(full, { [field]: next[field] ?? {} })
      }
      for (const [field, value] of Object.entries(patch)) {
        if (
          field !== 'mapDeltas' &&
          field !== 'membershipDeltas' &&
          field !== 'expectedPartitionGeneration'
        ) {
          Object.assign(full, { [field]: value })
        }
      }
      for (const field of [
        'activeWorktreeIdsOnShutdown',
        'activeConnectionIdsAtShutdown'
      ] as const) {
        const delta = patch.membershipDeltas?.[field]
        if (!delta) {
          continue
        }
        const remove = new Set(delta.remove ?? [])
        full[field] = [
          ...new Set([
            ...(fresh.session[field] ?? []).filter((id) => !remove.has(id)),
            ...(delta.add ?? [])
          ])
        ]
      }
      ack = await this.api.patch(full, hostArg)
    }
    if (!ack?.applied) {
      throw new Error(
        `Session partition ${host} was not applied: ${ack?.reason ?? 'missing acknowledgment'}`
      )
    }
  }
  protected routeUpdate(update: SessionProjectionUpdate, state: HostPersistenceState) {
    const routingChanged =
      update.routingChanged ??
      (!this.routingState ||
        (
          [
            'repos',
            'worktreesByRepo',
            'folderWorkspaces',
            'projectGroups',
            'restoredRuntimeHostIdByWorkspaceSessionKey',
            'hydratedRuntimeSessionHostIds',
            'contestedPrimaryHostBySessionKey',
            'contestedHostWorkspaceSessions'
          ] as const
        ).some((field) => this.routingState?.[field] !== state[field]))
    if (routingChanged) {
      this.routing = update.routing ?? buildHostSessionRouting(state)
      this.routingState = state
      this.epoch++
    }
    const routing = update.routing ?? this.routing ?? buildHostSessionRouting(state)
    const epoch = this.epoch
    // SAFETY: the splitter reads only present fields; a projection patch is a partial session.
    const slices = splitWorkspaceSessionByHost(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the splitter reads only present fields; a projection patch is a partial session.
      update.patch as WorkspaceSessionState,
      routing.hostIdByWorktreeId,
      {
        worktreeIdByTabId: update.terminalOwners,
        emptyContainerHostIds: update.full ? fullyOwnedSessionHostIds(state) : []
      }
    )
    if (routingChanged) {
      if (update.full) {
        this.parked.clear()
      } else {
        for (const [field, keys] of update.keys) {
          for (const key of keys) {
            this.parked.delete(unitId(field, key))
          }
        }
      }
      const parked = splitWorkspaceSessionByHost(
        getDefaultWorkspaceSession(),
        routing.hostIdByWorktreeId
      )
      for (const host of Object.keys(state.contestedHostWorkspaceSessions ?? {})) {
        Object.assign(parked, { [host]: {} })
      }
      const shadow = update.full
        ? state.contestedHostWorkspaceSessions
        : Object.fromEntries(
            Object.entries(state.contestedHostWorkspaceSessions ?? {}).map(([host, slice]) => [
              host,
              Object.fromEntries(
                [...update.keys].map(([field, keys]) => [
                  field,
                  Object.fromEntries(
                    [...keys].flatMap((key) => {
                      const value = sessionMap(slice ?? {}, field)?.[key]
                      return value === undefined ? [] : [[key, value]]
                    })
                  )
                ])
              )
            ])
          )
      attachHostSessionShadow(parked, shadow, routing.claims, 'replace')
      for (const [hostKey, slice] of Object.entries(parked)) {
        for (const field of update.keys.keys()) {
          for (const [key, value] of Object.entries(sessionMap(slice ?? {}, field) ?? {})) {
            const id = unitId(field, key),
              hosts = this.parked.get(id) ?? new Map<ExecutionHostId, Unit>()
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: parked keys come from validated execution-host partitions.
            const host = hostKey as ExecutionHostId
            hosts.set(host, { field, key, value, host })
            this.parked.set(id, hosts)
          }
        }
      }
    }
    if (update.full) {
      attachHostSessionShadow(
        slices,
        state.contestedHostWorkspaceSessions,
        routing.claims,
        'replace'
      )
    }
    if (update.full) {
      for (const id of this.desired.keys()) {
        this.pending.add(id)
      }
      this.desired.clear()
      for (const id of this.workspaces.keys()) {
        this.pendingWorkspaces.add(id)
      }
      this.workspaces.clear()
    }
    for (const [field, keys] of update.keys) {
      for (const key of keys) {
        const id = unitId(field, key)
        this.pending.add(id)
        const nextUnits = new Map(this.parked.get(id))
        this.desired.set(id, nextUnits)
        const value = sessionMap(update.patch, field)?.[key]
        for (const [host, slice] of Object.entries(slices)) {
          if (value !== undefined && sessionMap(slice ?? {}, field)?.[key] === value) {
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: slices are keyed by the validated execution-host routing function.
            nextUnits.set(host as ExecutionHostId, {
              field,
              key,
              value,
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: slices are keyed by the validated execution-host routing function.
              host: host as ExecutionHostId
            })
          }
        }
      }
    }

    return { routing, epoch, slices }
  }
}
