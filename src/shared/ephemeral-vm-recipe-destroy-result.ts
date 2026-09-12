import type { ProcessRunResult } from './ephemeral-vm-recipe-process'

export const EPHEMERAL_VM_CLEANUP_STOPPED_ERROR = 'Cleanup stopped by user.'

type FailedEphemeralVmRecipeDestroy = {
  ok: false
  skipped: false
  error: string
} & ProcessRunResult

export function getEphemeralVmRecipeDestroyFailure(
  result: ProcessRunResult
): FailedEphemeralVmRecipeDestroy | null {
  if (result.aborted) {
    return {
      ok: false,
      skipped: false,
      error: EPHEMERAL_VM_CLEANUP_STOPPED_ERROR,
      ...result
    }
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      skipped: false,
      error: `Destroy exited with code ${result.exitCode ?? 'unknown'}.`,
      ...result
    }
  }
  return null
}
