import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type { EphemeralVmRuntimeRecord } from '../../../../../shared/ephemeral-vm-runtimes'
import {
  getEphemeralVmHostState,
  type EphemeralVmHostLifecycle,
  type ExecutionHostVmState
} from '../../../../../shared/execution-host/execution-host-health'
import type { EphemeralVmFailure } from '../../../../../shared/ephemeral-vm-failure-copy'

/** The lifecycle facts the UI reads; recipe results (pairing codes, keys) never enter the store. */
export type EphemeralVmWorkspaceRuntime = Pick<
  EphemeralVmRuntimeRecord,
  'id' | 'status' | 'runtimeEnvironmentId'
> & {
  workspaceId: string
  /** Why the VM is in resume_failed / failed, as persisted on the record. */
  failure?: EphemeralVmFailure
  /** False when the recipe snapshot has no suspend step, so Suspend VM would do nothing. */
  canSuspend: boolean
}

export type EphemeralVmLifecycleSlice = {
  /** Live (not cleaned up) VM runtimes by the workspace they back. */
  ephemeralVmRuntimesByWorkspaceId: Record<string, EphemeralVmWorkspaceRuntime>
  /** Workspaces whose VM resume is in flight; the record only flips when it finishes. */
  wakingEphemeralVmWorkspaceIds: Record<string, true>
  refreshEphemeralVmRuntimes: () => Promise<void>
  setEphemeralVmWorkspaceWaking: (workspaceId: string, waking: boolean) => void
}

const RETIRED_STATUSES = new Set<EphemeralVmRuntimeRecord['status']>(['cleaned', 'cleanup_pending'])

function recordFailure(record: EphemeralVmRuntimeRecord): EphemeralVmFailure | undefined {
  // Provision failures (incl. interrupted creates) use the cleanup error the Settings row shows.
  const [error, errorCode, errorParams] =
    record.status === 'failed'
      ? [record.cleanupLastError, record.cleanupLastErrorCode, record.cleanupLastErrorParams]
      : record.status === 'resume_failed'
        ? [
            record.lifecycleLastError,
            record.lifecycleLastErrorCode,
            record.lifecycleLastErrorParams
          ]
        : [undefined, undefined, undefined]
  if (!error) {
    return undefined
  }
  return { error, ...(errorCode ? { errorCode } : {}), ...(errorParams ? { errorParams } : {}) }
}

export function projectEphemeralVmWorkspaceRuntimes(
  records: readonly EphemeralVmRuntimeRecord[]
): Record<string, EphemeralVmWorkspaceRuntime> {
  const byWorkspaceId: Record<string, EphemeralVmWorkspaceRuntime> = {}
  const provisioned = new Set<string>()
  for (const record of records) {
    if (!record.workspaceId || RETIRED_STATUSES.has(record.status)) {
      continue
    }
    const hasResult = record.recipeResult !== undefined
    // Resume/suspend act on the first (newest) provisioned record; a result-less write-ahead row
    // (provisioning, or a failed/interrupted create) only shows when nothing provisioned exists.
    if (provisioned.has(record.workspaceId) || (byWorkspaceId[record.workspaceId] && !hasResult)) {
      continue
    }
    if (hasResult) {
      provisioned.add(record.workspaceId)
    }
    const failure = recordFailure(record)
    byWorkspaceId[record.workspaceId] = {
      id: record.id,
      workspaceId: record.workspaceId,
      status: record.status,
      ...(record.runtimeEnvironmentId ? { runtimeEnvironmentId: record.runtimeEnvironmentId } : {}),
      ...(failure ? { failure } : {}),
      // Records without a snapshot resolve the recipe from the repo at suspend time.
      // Main only suspends a VM whose repo it can resolve (findWorkspaceEphemeralVmRuntime).
      canSuspend: Boolean(record.repoId) && (!record.recipe || Boolean(record.recipe.suspend))
    }
  }
  return byWorkspaceId
}

function sameRuntimes(
  a: Record<string, EphemeralVmWorkspaceRuntime>,
  b: Record<string, EphemeralVmWorkspaceRuntime>
): boolean {
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) {
    return false
  }
  return aKeys.every((key) => {
    const left = a[key]
    const right = b[key]
    return (
      right !== undefined &&
      left.id === right.id &&
      left.status === right.status &&
      left.runtimeEnvironmentId === right.runtimeEnvironmentId &&
      left.canSuspend === right.canSuspend &&
      left.failure?.error === right.failure?.error &&
      left.failure?.errorCode === right.failure?.errorCode &&
      JSON.stringify(left.failure?.errorParams) === JSON.stringify(right.failure?.errorParams)
    )
  })
}

let refreshSequence = 0
let latestRefresh: Promise<void> = Promise.resolve()

export const createEphemeralVmLifecycleSlice: StateCreator<
  AppState,
  [],
  [],
  EphemeralVmLifecycleSlice
> = (set) => ({
  ephemeralVmRuntimesByWorkspaceId: {},
  wakingEphemeralVmWorkspaceIds: {},
  refreshEphemeralVmRuntimes: () => {
    const listRuntimes = window.api?.ephemeralVm?.listRuntimes
    if (!listRuntimes) {
      return Promise.resolve()
    }
    const sequence = ++refreshSequence
    const refresh = (async (): Promise<void> => {
      const next = projectEphemeralVmWorkspaceRuntimes(await listRuntimes())
      // Out-of-order replies must not roll a newer lifecycle status back; a superseded caller
      // settles with the newer read, so it never acts on a store that has not caught up.
      if (sequence !== refreshSequence) {
        return latestRefresh
      }
      set((state) =>
        sameRuntimes(state.ephemeralVmRuntimesByWorkspaceId, next)
          ? state
          : { ephemeralVmRuntimesByWorkspaceId: next }
      )
    })()
    latestRefresh = refresh
    return refresh
  },
  setEphemeralVmWorkspaceWaking: (workspaceId, waking) =>
    set((state) => {
      if (Boolean(state.wakingEphemeralVmWorkspaceIds[workspaceId]) === waking) {
        return state
      }
      const next = { ...state.wakingEphemeralVmWorkspaceIds }
      if (waking) {
        next[workspaceId] = true
      } else {
        delete next[workspaceId]
      }
      return { wakingEphemeralVmWorkspaceIds: next }
    })
})

type LifecycleInput = Pick<
  EphemeralVmLifecycleSlice,
  'ephemeralVmRuntimesByWorkspaceId' | 'wakingEphemeralVmWorkspaceIds'
>

type HostLifecycleCache = {
  runtimes: LifecycleInput['ephemeralVmRuntimesByWorkspaceId'] | undefined
  waking: LifecycleInput['wakingEphemeralVmWorkspaceIds'] | undefined
  result: EphemeralVmHostLifecycle[]
}

let hostLifecycleCache: HostLifecycleCache | null = null

/** Stable per input identity so host registries memoize across renders. */
export function selectEphemeralVmHostLifecycles(
  state: Partial<LifecycleInput>
): EphemeralVmHostLifecycle[] {
  const runtimes = state.ephemeralVmRuntimesByWorkspaceId
  const waking = state.wakingEphemeralVmWorkspaceIds
  const cached = hostLifecycleCache
  if (cached && cached.runtimes === runtimes && cached.waking === waking) {
    return cached.result
  }
  const result = Object.values(runtimes ?? {}).flatMap((runtime) =>
    runtime.runtimeEnvironmentId
      ? [
          {
            runtimeEnvironmentId: runtime.runtimeEnvironmentId,
            status: runtime.status,
            waking: Boolean(waking?.[runtime.workspaceId])
          }
        ]
      : []
  )
  hostLifecycleCache = { runtimes, waking, result }
  return result
}

export function selectEphemeralVmWorkspaceRuntime(
  state: Partial<LifecycleInput>,
  workspaceId: string
): EphemeralVmWorkspaceRuntime | null {
  return state.ephemeralVmRuntimesByWorkspaceId?.[workspaceId] ?? null
}

export function selectEphemeralVmWorkspaceWaking(
  state: Partial<LifecycleInput>,
  workspaceId: string
): boolean {
  return state.wakingEphemeralVmWorkspaceIds?.[workspaceId] === true
}

export function selectEphemeralVmWorkspaceState(
  state: Partial<LifecycleInput>,
  workspaceId: string
): ExecutionHostVmState | null {
  const runtime = selectEphemeralVmWorkspaceRuntime(state, workspaceId)
  return runtime
    ? getEphemeralVmHostState(
        runtime.status,
        Boolean(state.wakingEphemeralVmWorkspaceIds?.[workspaceId])
      )
    : null
}

/** The persisted reason behind a Resume failed / Setup failed row. */
export function selectEphemeralVmWorkspaceFailure(
  state: Partial<LifecycleInput>,
  workspaceId: string
): EphemeralVmFailure | null {
  return selectEphemeralVmWorkspaceRuntime(state, workspaceId)?.failure ?? null
}
