import {
  isRecoverableRemoteRuntimeConnectionError,
  toRemoteRuntimeClientErrorLike
} from '../../../shared/remote-runtime-client-error-classification'

/** Whether a create may have run on the host even though no answer reached this client. */
export function isRemoteCreateOutcomeUnknown(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') {
    return false
  }
  // Why: the desktop bridge returns transport loss as a failure envelope, so the code (not the
  // error class) says whether the host actually answered.
  return isRecoverableRemoteRuntimeConnectionError(toRemoteRuntimeClientErrorLike(error))
}
