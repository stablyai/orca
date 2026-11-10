import type { ProcessRunResult } from './ephemeral-vm-recipe-process'
import {
  EPHEMERAL_VM_FAILURE_COPY,
  ephemeralVmExitFailure,
  ephemeralVmFailure,
  ephemeralVmTimeoutFailure,
  type EphemeralVmFailure
} from './ephemeral-vm-failure-copy'

export const EPHEMERAL_VM_CLEANUP_STOPPED_ERROR = EPHEMERAL_VM_FAILURE_COPY.cleanupStopped

type FailedEphemeralVmRecipeDestroy = {
  ok: false
  skipped: false
} & EphemeralVmFailure &
  ProcessRunResult

export function getEphemeralVmRecipeDestroyFailure(
  result: ProcessRunResult,
  timeoutSeconds: number
): FailedEphemeralVmRecipeDestroy | null {
  if (result.timedOut) {
    return {
      ok: false,
      skipped: false,
      ...ephemeralVmTimeoutFailure('destroy', timeoutSeconds),
      ...result
    }
  }
  if (result.aborted) {
    return {
      ok: false,
      skipped: false,
      ...ephemeralVmFailure('cleanupStopped'),
      ...result
    }
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      skipped: false,
      ...ephemeralVmExitFailure('destroy', result.exitCode),
      ...result
    }
  }
  return null
}
