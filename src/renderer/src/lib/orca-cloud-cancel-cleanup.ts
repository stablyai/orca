// Cancel feedback for an Orca Cloud create: "Deleting the sandbox…" until every step that can still
// own the sandbox has settled, then "Sandbox deleted" (or a failure with Try again).
import { ORCA_CLOUD_RECIPE_ID } from '../../../shared/hosted-sandbox/orca-cloud-recipe-id'
import type { WorktreeCreationRequest } from '@/lib/workspace/creation/pending-worktree-creation'
import {
  showOrcaCloudCleanupDoneToast,
  showOrcaCloudCleanupFailedToast,
  showOrcaCloudCleanupStartedToast
} from '@/lib/orca-cloud-session-toasts'

/** Resolves false when the step may have left the sandbox running. */
type CleanupStep = Promise<boolean>

/** Which runtime records belong to the canceled create. */
export type OrcaCloudCancelScope = { runtimeId?: string; createStartedAt: number }

type Cleanup = {
  pending: number
  failed: boolean
  scope: OrcaCloudCancelScope
  timeout?: ReturnType<typeof setTimeout>
}

// A provision that never settles must not leave "Deleting the sandbox…" spinning forever.
const CLEANUP_TIMEOUT_MS = 3 * 60_000

// Orca Cloud creates still running, by creation id; after a cancel each ends once its own cleanup has.
const inFlight = new Map<string, Set<Promise<unknown>>>()
const cleanups = new Map<string, Cleanup>()

export function isOrcaCloudCreateRequest(request: WorktreeCreationRequest): boolean {
  return request.ephemeralVmRecipe?.recipeId === ORCA_CLOUD_RECIPE_ID
}

/** A create run a cancel must wait for: it may still bring the sandbox up or tear it down. */
export function trackOrcaCloudCreateStep<T>(creationId: string, step: Promise<T>): Promise<T> {
  const steps = inFlight.get(creationId) ?? new Set()
  inFlight.set(creationId, steps)
  steps.add(step)
  const settled = (): void => {
    steps.delete(step)
    if (steps.size === 0 && inFlight.get(creationId) === steps) {
      inFlight.delete(creationId)
    }
  }
  step.then(settled, settled)
  const cleanup = cleanups.get(creationId)
  if (cleanup) {
    waitForStep(
      creationId,
      cleanup,
      step.then(() => true)
    )
  }
  return step
}

/** The user canceled an Orca Cloud create; `steps` are the cleanups the cancel itself started. */
export function beginOrcaCloudCancelCleanup(
  creationId: string,
  steps: readonly CleanupStep[],
  scope: OrcaCloudCancelScope
): void {
  if (cleanups.has(creationId)) {
    return
  }
  const cleanup: Cleanup = { pending: 0, failed: false, scope }
  cleanup.timeout = setTimeout(() => finish(creationId, cleanup, true), CLEANUP_TIMEOUT_MS)
  cleanups.set(creationId, cleanup)
  showOrcaCloudCleanupStartedToast(creationId)
  for (const step of inFlight.get(creationId) ?? []) {
    waitForStep(
      creationId,
      cleanup,
      step.then(() => true)
    )
  }
  for (const step of steps) {
    waitForStep(creationId, cleanup, step)
  }
  finishWhenIdle(creationId, cleanup)
}

function waitForStep(creationId: string, cleanup: Cleanup, step: CleanupStep): void {
  cleanup.pending += 1
  void step
    .catch(() => false)
    .then((ok) => {
      cleanup.failed ||= !ok
      cleanup.pending -= 1
      finishWhenIdle(creationId, cleanup)
    })
}

function finishWhenIdle(creationId: string, cleanup: Cleanup): void {
  if (cleanup.pending === 0) {
    finish(creationId, cleanup, false)
  }
}

function finish(creationId: string, cleanup: Cleanup, timedOut: boolean): void {
  if (cleanups.get(creationId) !== cleanup) {
    return
  }
  cleanups.delete(creationId)
  clearTimeout(cleanup.timeout)
  void cleanupLeftSandboxRunning(cleanup, timedOut).then((failed) => {
    if (failed) {
      showOrcaCloudCleanupFailedToast(creationId, () => retryCleanup(creationId, cleanup.scope))
    } else {
      showOrcaCloudCleanupDoneToast(creationId)
    }
  })
}

const SETTLED_STATUSES = new Set(['cleaned', 'failed'])

/** This create's Orca Cloud runtimes that are not yet deleted. */
async function liveRuntimeIds(scope: OrcaCloudCancelScope, timedOut: boolean): Promise<string[]> {
  const runtimes = await window.api.ephemeralVm.listRuntimes().catch(() => [])
  return runtimes
    .filter(
      (runtime) =>
        runtime.recipe?.provider === 'orca-cloud' &&
        (scope.runtimeId
          ? runtime.id === scope.runtimeId
          : runtime.createdAt >= scope.createStartedAt) &&
        (runtime.status === 'cleanup_failed' || (timedOut && !SETTLED_STATUSES.has(runtime.status)))
    )
    .map((runtime) => runtime.id)
}

// The create's own cleanups only log failures, so confirm against this create's runtime records.
async function cleanupLeftSandboxRunning(cleanup: Cleanup, timedOut: boolean): Promise<boolean> {
  return cleanup.failed || (await liveRuntimeIds(cleanup.scope, timedOut)).length > 0
}

/** "Try again": delete every sandbox of this create that is still around, with the same feedback. */
function retryCleanup(creationId: string, scope: OrcaCloudCancelScope): void {
  const steps = liveRuntimeIds(scope, true).then((ids) =>
    Promise.all(
      ids.map((runtimeId) =>
        window.api.ephemeralVm
          .cleanup({ runtimeId })
          .then((runtime) => runtime.cleanupStatus !== 'failed')
          .catch(() => false)
      )
    ).then((results) => results.every(Boolean))
  )
  beginOrcaCloudCancelCleanup(creationId, [steps], scope)
}
