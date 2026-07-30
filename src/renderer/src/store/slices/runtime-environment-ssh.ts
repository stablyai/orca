import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  SshConnectionState,
  SshConnectionStatus,
  SshTargetSummary
} from '../../../../shared/ssh-types'
import { sshConnectionStatesEqual, sshTargetLabelsEqual } from './ssh-target-cleanup'

/**
 * SSH state of one remote Orca server's own SSH targets, mirrored on this
 * client. Kept strictly separate from the local `SshSlice` maps so a remote
 * machine's targets can never pollute local SSH settings, pickers, or the
 * execution-host registry — and vice versa (STA-1468, desktop topology).
 */
export type RuntimeEnvironmentSshBucket = {
  connectionStates: Map<string, SshConnectionState>
  targetLabels: Map<string, string>
  removedTargetLabels: Map<string, string>
  /** Mirrors the local `sshTargetsHydrated` positive-evidence rule: absence
   * from `targetLabels` only counts as target removal once a target list
   * actually loaded from that environment (even an empty one). */
  targetsHydrated: boolean
}

export type RuntimeEnvironmentSshSlice = {
  /**
   * Per-runtime-environment SSH state buckets, keyed by environment id.
   * Do NOT read this map directly from components — use the
   * `selectRuntimeAwareSsh*` selectors below, which route between the local
   * SSH maps (`environmentId === null`) and the owning environment's bucket.
   */
  sshStateByEnvironment: Map<string, RuntimeEnvironmentSshBucket>
  setEnvironmentSshConnectionState: (
    environmentId: string,
    targetId: string,
    state: SshConnectionState,
    generation?: number
  ) => void
  setEnvironmentSshTargetsMetadata: (
    environmentId: string,
    targets: SshTargetSummary[],
    generation?: number
  ) => void
  setEnvironmentRemovedSshTargetLabels: (
    environmentId: string,
    labels: Record<string, string>,
    generation?: number
  ) => void
  /** Transport to the environment dropped: its mirrored SSH state can no
   * longer be trusted (it may hold a pre-drop "connected"). Downgrades the
   * bucket to unhydrated and clears connection states so reads resolve to
   * "unknown" until a reconnect re-hydrates. */
  markEnvironmentSshStateStale: (environmentId: string) => void
  removeEnvironmentSshState: (environmentId: string) => void
  /** Drops buckets for environments no longer in the saved set. */
  retainEnvironmentSshState: (environmentIds: Iterable<string>) => void
}

const EMPTY_BUCKET: RuntimeEnvironmentSshBucket = {
  connectionStates: new Map(),
  targetLabels: new Map(),
  removedTargetLabels: new Map(),
  targetsHydrated: false
}

const stateGenerationByEnvironment = new Map<string, number>()
const targetConnectionGenerationByEnvironment = new Map<string, number>()

function targetGenerationKey(environmentId: string, targetId: string): string {
  return `${environmentId}\0${targetId}`
}

export function getEnvironmentSshTargetConnectionGeneration(
  environmentId: string,
  targetId: string
): number {
  return (
    targetConnectionGenerationByEnvironment.get(targetGenerationKey(environmentId, targetId)) ?? 0
  )
}

function advanceEnvironmentSshTargetConnectionGeneration(
  environmentId: string,
  targetId: string
): void {
  const key = targetGenerationKey(environmentId, targetId)
  targetConnectionGenerationByEnvironment.set(
    key,
    getEnvironmentSshTargetConnectionGeneration(environmentId, targetId) + 1
  )
}

export function getEnvironmentSshStateGeneration(environmentId: string): number {
  return stateGenerationByEnvironment.get(environmentId) ?? 0
}

function advanceEnvironmentSshStateGeneration(environmentId: string): void {
  stateGenerationByEnvironment.set(
    environmentId,
    getEnvironmentSshStateGeneration(environmentId) + 1
  )
}

function generationIsCurrent(environmentId: string, generation: number | undefined): boolean {
  return generation === undefined || generation === getEnvironmentSshStateGeneration(environmentId)
}

function getBucket(
  buckets: Map<string, RuntimeEnvironmentSshBucket>,
  environmentId: string
): RuntimeEnvironmentSshBucket {
  return buckets.get(environmentId) ?? EMPTY_BUCKET
}

function withBucket(
  s: Pick<AppState, 'sshStateByEnvironment'>,
  environmentId: string,
  bucket: RuntimeEnvironmentSshBucket
): Pick<AppState, 'sshStateByEnvironment'> {
  const next = new Map(s.sshStateByEnvironment)
  next.set(environmentId, bucket)
  return { sshStateByEnvironment: next }
}

function removedLabelsEqual(current: Map<string, string>, labels: Record<string, string>): boolean {
  const entries = Object.entries(labels)
  return (
    entries.length === current.size && entries.every(([id, label]) => current.get(id) === label)
  )
}

export const createRuntimeEnvironmentSshSlice: StateCreator<
  AppState,
  [],
  [],
  RuntimeEnvironmentSshSlice
> = (set) => ({
  sshStateByEnvironment: new Map(),

  setEnvironmentSshConnectionState: (environmentId, targetId, state, generation) =>
    set((s) => {
      if (!generationIsCurrent(environmentId, generation)) {
        return s
      }
      const bucket = getBucket(s.sshStateByEnvironment, environmentId)
      if (sshConnectionStatesEqual(bucket.connectionStates.get(targetId), state)) {
        return s
      }
      advanceEnvironmentSshTargetConnectionGeneration(environmentId, targetId)
      const connectionStates = new Map(bucket.connectionStates)
      connectionStates.set(targetId, state)
      return withBucket(s, environmentId, { ...bucket, connectionStates })
    }),

  setEnvironmentSshTargetsMetadata: (environmentId, targets, generation) =>
    set((s) => {
      if (!generationIsCurrent(environmentId, generation)) {
        return s
      }
      const bucket = getBucket(s.sshStateByEnvironment, environmentId)
      const targetIds = new Set(targets.map((target) => target.id))
      const priorTargetIds = new Set([
        ...bucket.targetLabels.keys(),
        ...bucket.connectionStates.keys()
      ])
      for (const targetId of priorTargetIds) {
        if (!targetIds.has(targetId)) {
          // Why: remove/re-add under the same target id must invalidate mutations captured for the removed SSH session.
          advanceEnvironmentSshTargetConnectionGeneration(environmentId, targetId)
        }
      }
      const connectionStates = new Map(
        Array.from(bucket.connectionStates).filter(([targetId]) => targetIds.has(targetId))
      )
      if (sshTargetLabelsEqual(bucket.targetLabels, targets)) {
        // Why: an unchanged (even empty) list is still a successful load — the
        // hydration flag must flip on the first fetch of an empty target set.
        return bucket.targetsHydrated
          ? s
          : withBucket(s, environmentId, { ...bucket, connectionStates, targetsHydrated: true })
      }
      return withBucket(s, environmentId, {
        ...bucket,
        connectionStates,
        targetLabels: new Map(targets.map((target) => [target.id, target.label])),
        targetsHydrated: true
      })
    }),

  setEnvironmentRemovedSshTargetLabels: (environmentId, labels, generation) =>
    set((s) => {
      if (!generationIsCurrent(environmentId, generation)) {
        return s
      }
      const bucket = getBucket(s.sshStateByEnvironment, environmentId)
      if (removedLabelsEqual(bucket.removedTargetLabels, labels)) {
        return s
      }
      return withBucket(s, environmentId, {
        ...bucket,
        removedTargetLabels: new Map(Object.entries(labels))
      })
    }),

  markEnvironmentSshStateStale: (environmentId) =>
    set((s) => {
      advanceEnvironmentSshStateGeneration(environmentId)
      const bucket = s.sshStateByEnvironment.get(environmentId)
      if (!bucket || (!bucket.targetsHydrated && bucket.connectionStates.size === 0)) {
        return s
      }
      // Labels are kept so a re-hydrating overlay can still show a friendly
      // host name; hydration=false alone forces reads back to "unknown".
      return withBucket(s, environmentId, {
        ...bucket,
        connectionStates: new Map(),
        targetsHydrated: false
      })
    }),

  removeEnvironmentSshState: (environmentId) =>
    set((s) => {
      advanceEnvironmentSshStateGeneration(environmentId)
      if (!s.sshStateByEnvironment.has(environmentId)) {
        return s
      }
      const next = new Map(s.sshStateByEnvironment)
      next.delete(environmentId)
      return { sshStateByEnvironment: next }
    }),

  retainEnvironmentSshState: (environmentIds) =>
    set((s) => {
      const keep = new Set(environmentIds)
      let changed = false
      const next = new Map(s.sshStateByEnvironment)
      for (const id of next.keys()) {
        if (!keep.has(id)) {
          advanceEnvironmentSshStateGeneration(id)
          next.delete(id)
          changed = true
        }
      }
      return changed ? { sshStateByEnvironment: next } : s
    })
})

type RuntimeAwareSshReadState = Pick<
  AppState,
  | 'sshConnectionStates'
  | 'sshTargetLabels'
  | 'removedSshTargetLabels'
  | 'sshTargetsHydrated'
  | 'sshStateByEnvironment'
> &
  Partial<Pick<AppState, 'runtimeStatusByEnvironmentId'>>

function isEnvironmentReachable(state: RuntimeAwareSshReadState, environmentId: string): boolean {
  return Boolean(state.runtimeStatusByEnvironmentId?.get(environmentId)?.status)
}

/**
 * Reconnect-overlay status for an SSH target owned by `environmentId` (a
 * remote Orca server) or by this machine (`environmentId === null`).
 *
 * Returns null when the state is unknown — environment unreachable or its
 * bucket not hydrated — so callers show nothing rather than another machine's
 * stale state. The runtime environment's own disconnected UI outranks any SSH
 * overlay in that case.
 */
export function selectRuntimeAwareSshStatus(
  state: RuntimeAwareSshReadState,
  environmentId: string | null,
  targetId: string
): SshConnectionStatus | null {
  if (environmentId === null) {
    return state.sshConnectionStates.get(targetId)?.status ?? 'disconnected'
  }
  if (!isEnvironmentReachable(state, environmentId)) {
    return null
  }
  const bucket = state.sshStateByEnvironment.get(environmentId)
  if (!bucket?.targetsHydrated) {
    return null
  }
  return bucket.connectionStates.get(targetId)?.status ?? null
}

export function selectRuntimeAwareSshTargetLabel(
  state: RuntimeAwareSshReadState,
  environmentId: string | null,
  targetId: string
): string {
  if (environmentId === null) {
    return (
      state.sshTargetLabels.get(targetId) ??
      // Fall back to the removed target's last known label (ghost host) before
      // the raw id, so a removed host shows its name instead of ssh-<ts>-<rand>.
      state.removedSshTargetLabels.get(targetId) ??
      targetId
    )
  }
  const bucket = state.sshStateByEnvironment.get(environmentId)
  return bucket?.targetLabels.get(targetId) ?? bucket?.removedTargetLabels.get(targetId) ?? targetId
}

/**
 * True only on positive evidence that the target was removed on its owning
 * host: a removal tombstone, or a hydrated target list that lacks the id.
 * An unreachable environment or un-hydrated bucket never reports removal, so
 * destructive "remove workspace" UI cannot be offered out of ignorance.
 */
export function selectRuntimeAwareSshTargetRemoved(
  state: RuntimeAwareSshReadState,
  environmentId: string | null,
  targetId: string
): boolean {
  if (environmentId === null) {
    return (
      state.removedSshTargetLabels.has(targetId) ||
      (state.sshTargetsHydrated && !state.sshTargetLabels.has(targetId))
    )
  }
  if (!isEnvironmentReachable(state, environmentId)) {
    return false
  }
  const bucket = state.sshStateByEnvironment.get(environmentId)
  if (!bucket) {
    return false
  }
  return (
    bucket.removedTargetLabels.has(targetId) ||
    (bucket.targetsHydrated && !bucket.targetLabels.has(targetId))
  )
}
