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
export type OrcaCloudCancelScope = {
  runtimeId?: string
  createStartedAt: number
  canceledAt: number
}

type Cleanup = {
  pending: number
  failed: boolean
  scope: OrcaCloudCancelScope
  /** A Try again: anything of this create still up afterwards counts as not deleted. */
  retry: boolean
  timeout?: ReturnType<typeof setTimeout>
}

// A provision that never settles must not leave "Deleting the sandbox…" spinning forever.
const CLEANUP_TIMEOUT_MS = 3 * 60_000

// Orca Cloud creates still running, by creation id, as "left nothing running" outcomes; after a
// cancel each ends once its own cleanup has.
const inFlight = new Map<string, Set<CleanupStep>>()
const cleanups = new Map<string, Cleanup>()
// EP-5: a step that couldn't confirm its sandbox deleted leaves its own Try again here.
const retries = new Map<string, () => Promise<boolean>>()

export function isOrcaCloudCreateRequest(request: WorktreeCreationRequest): boolean {
  return request.ephemeralVmRecipe?.recipeId === ORCA_CLOUD_RECIPE_ID
}

/**
 * A create run a cancel must wait for: it may still bring the sandbox up or tear it down.
 * `leftNothingRunning` reads its result (EP-5): false when it couldn't confirm its sandbox deleted,
 * so the cancel never says "Sandbox deleted" for it. A rejected step counts as not confirmed.
 */
export function trackOrcaCloudCreateStep<T>(
  creationId: string,
  step: Promise<T>,
  leftNothingRunning: (value: T) => boolean = () => true
): Promise<T> {
  const steps = inFlight.get(creationId) ?? new Set()
  inFlight.set(creationId, steps)
  const outcome = step.then(leftNothingRunning)
  // Read by a cancel's cleanup if there is one; never an unhandled rejection otherwise.
  outcome.catch(() => undefined)
  steps.add(outcome)
  const settled = (): void => {
    steps.delete(outcome)
    if (steps.size === 0 && inFlight.get(creationId) === steps) {
      inFlight.delete(creationId)
    }
  }
  outcome.then(settled, settled)
  const cleanup = cleanups.get(creationId)
  if (cleanup) {
    waitForStep(creationId, cleanup, outcome)
  }
  return step
}

/** EP-5: how Try again deletes what a step of this create couldn't confirm deleted. */
export function setOrcaCloudCancelRetry(creationId: string, retry: () => Promise<boolean>): void {
  retries.set(creationId, retry)
}

/** The user canceled an Orca Cloud create; `steps` are the cleanups the cancel itself started. */
export function beginOrcaCloudCancelCleanup(
  creationId: string,
  steps: readonly CleanupStep[],
  scope: OrcaCloudCancelScope,
  retry = false
): void {
  if (cleanups.has(creationId)) {
    return
  }
  const cleanup: Cleanup = { pending: 0, failed: false, scope, retry }
  cleanup.timeout = setTimeout(() => finish(creationId, cleanup, true), CLEANUP_TIMEOUT_MS)
  cleanups.set(creationId, cleanup)
  showOrcaCloudCleanupStartedToast(creationId)
  for (const step of inFlight.get(creationId) ?? []) {
    waitForStep(creationId, cleanup, step)
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
  // A provision still in flight at the cancel can write its record after it; once every tracked
  // step has settled, nothing of this create can appear later, so widen the window to now.
  if (!timedOut) {
    cleanup.scope = { ...cleanup.scope, canceledAt: Math.max(cleanup.scope.canceledAt, Date.now()) }
  }
  void cleanupLeftSandboxRunning(cleanup, timedOut || cleanup.retry).then((failed) => {
    if (failed) {
      showOrcaCloudCleanupFailedToast(creationId, () => retryCleanup(creationId, cleanup.scope))
    } else {
      retries.delete(creationId)
      showOrcaCloudCleanupDoneToast(creationId)
    }
  })
}

const SETTLED_STATUSES = new Set(['cleaned', 'failed'])

/** This create's Orca Cloud runtimes that may still be up; null when the records can't be read.
 *  `failedOnly` limits it to sandboxes whose delete failed, the only ones safe to delete again. */
async function leftoverRuntimeIds(
  scope: OrcaCloudCancelScope,
  { timedOut, failedOnly }: { timedOut: boolean; failedOnly: boolean }
): Promise<string[] | null> {
  const runtimes = await window.api.ephemeralVm.listRuntimes().catch(() => null)
  if (!runtimes) {
    return null
  }
  return runtimes
    .filter(
      (runtime) =>
        runtime.recipe?.provider === 'orca-cloud' &&
        (scope.runtimeId
          ? runtime.id === scope.runtimeId
          : // Without an id, only sandboxes created by this attempt, never a later create's.
            runtime.createdAt >= scope.createStartedAt && runtime.createdAt <= scope.canceledAt) &&
        (runtime.status === 'cleanup_failed' ||
          (!failedOnly && timedOut && !SETTLED_STATUSES.has(runtime.status)))
    )
    .map((runtime) => runtime.id)
}

// The create's own cleanups only log failures, so confirm against this create's runtime records.
async function cleanupLeftSandboxRunning(cleanup: Cleanup, timedOut: boolean): Promise<boolean> {
  if (cleanup.failed) {
    return true
  }
  const ids = await leftoverRuntimeIds(cleanup.scope, { timedOut, failedOnly: false })
  return ids === null || ids.length > 0
}

/** "Try again": delete again every sandbox of this create whose delete failed, with the same feedback. */
function retryCleanup(creationId: string, scope: OrcaCloudCancelScope): void {
  // A second click while the retry runs must not send the deletes twice.
  if (cleanups.has(creationId)) {
    return
  }
  const retry = retries.get(creationId)
  // A create with no runtime records (GitHub-only) retries its own delete instead.
  const own = retry
    ? retry()
        .catch(() => false)
        .then((ok) => {
          if (ok && retries.get(creationId) === retry) {
            retries.delete(creationId)
          }
          return ok
        })
    : Promise.resolve(true)
  const records = leftoverRuntimeIds(scope, { timedOut: false, failedOnly: true }).then((ids) =>
    ids === null
      ? false
      : Promise.all(
          ids.map((runtimeId) =>
            window.api.ephemeralVm
              .cleanup({ runtimeId })
              .then((runtime) => runtime.cleanupStatus !== 'failed')
              .catch(() => false)
          )
        ).then((results) => results.every(Boolean))
  )
  beginOrcaCloudCancelCleanup(creationId, [own, records], scope, true)
}
