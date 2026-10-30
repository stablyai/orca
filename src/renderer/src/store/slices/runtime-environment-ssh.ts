import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { SshConnectionState, SshTargetSummary } from '../../../../shared/ssh-types'
import { sshConnectionStatesEqual } from './ssh-connection-state-equality'
import {
  collectSshTargetGenerations,
  sshTargetGenerationsEqual,
  sshTargetLabelsEqual
} from './ssh-target-cleanup'
import { createBoundedGenerationMap } from '../../lib/bounded-generation-map'
export {
  selectRuntimeAwareSshConnectionGeneration,
  selectRuntimeAwareSshError,
  selectRuntimeAwareSshStatus,
  selectRuntimeAwareSshTargetLabel,
  selectRuntimeAwareSshTargetRemoved
} from './runtime-environment-ssh-selectors'

/** Mirror each runtime’s SSH targets separately from local maps to prevent cross-host settings, picker and registry contamination (STA-1468). */
export type RuntimeEnvironmentSshBucket = {
  connectionStates: Map<string, SshConnectionState>
  targetLabels: Map<string, string>
  /** Durable registration generation for automation fences; never guess missing legacy values, and clear when stale. */
  targetGenerations: Map<string, number>
  removedTargetLabels: Map<string, string>
  /** Absence proves removal only after a target list loads, including an empty list. */
  targetsHydrated: boolean
}

export type RuntimeEnvironmentSshSlice = {
  /** Read through selectRuntimeAwareSsh* to route local versus owning-environment state. */
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
  /** Clear connection evidence on transport drop; reads remain unknown until rehydration. */
  markEnvironmentSshStateStale: (environmentId: string) => void
  removeEnvironmentSshState: (environmentId: string) => void
  /** Drops buckets for environments no longer in the saved set. */
  retainEnvironmentSshState: (environmentIds: Iterable<string>) => void
}

const EMPTY_BUCKET: RuntimeEnvironmentSshBucket = {
  connectionStates: new Map(),
  targetLabels: new Map(),
  targetGenerations: new Map(),
  removedTargetLabels: new Map(),
  targetsHydrated: false
}

const targetConnectionGenerations = createBoundedGenerationMap(4096)
const stateGenerations = createBoundedGenerationMap(512)

function targetGenerationKey(environmentId: string, targetId: string): string {
  return `${environmentId}\0${targetId}`
}

export function getEnvironmentSshTargetConnectionGeneration(
  environmentId: string,
  targetId: string
): number {
  return targetConnectionGenerations.get(targetGenerationKey(environmentId, targetId))
}

function advanceEnvironmentSshTargetConnectionGeneration(
  environmentId: string,
  targetId: string
): void {
  targetConnectionGenerations.advance(targetGenerationKey(environmentId, targetId))
}

export function getEnvironmentSshStateGeneration(environmentId: string): number {
  return stateGenerations.get(environmentId)
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
      const targetGenerations = collectSshTargetGenerations(targets)
      if (
        sshTargetLabelsEqual(bucket.targetLabels, targets) &&
        sshTargetGenerationsEqual(bucket.targetGenerations, targetGenerations)
      ) {
        // An unchanged empty list still proves first hydration.
        return bucket.targetsHydrated
          ? s
          : withBucket(s, environmentId, { ...bucket, connectionStates, targetsHydrated: true })
      }
      return withBucket(s, environmentId, {
        ...bucket,
        connectionStates,
        targetLabels: new Map(targets.map((target) => [target.id, target.label])),
        targetGenerations,
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
      stateGenerations.advance(environmentId)
      const bucket = s.sshStateByEnvironment.get(environmentId)
      if (
        !bucket ||
        (!bucket.targetsHydrated &&
          bucket.connectionStates.size === 0 &&
          bucket.targetGenerations.size === 0)
      ) {
        return s
      }
      // Keep friendly labels while unhydrated reads return unknown; drop unverified generations so fencing cannot use them.
      return withBucket(s, environmentId, {
        ...bucket,
        connectionStates: new Map(),
        targetGenerations: new Map(),
        targetsHydrated: false
      })
    }),

  removeEnvironmentSshState: (environmentId) =>
    set((s) => {
      stateGenerations.advance(environmentId)
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
          stateGenerations.advance(id)
          next.delete(id)
          changed = true
        }
      }
      return changed ? { sshStateByEnvironment: next } : s
    })
})
