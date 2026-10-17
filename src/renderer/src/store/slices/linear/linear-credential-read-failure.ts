import {
  credentialDecryptionMessage,
  isIntegrationCredentialDecryptionError
} from '../../../../../shared/integration-credential-errors'
import type { LinearSliceGet, LinearSliceSet } from './linear-slice-contract'

// Why: status refresh is async, and an empty read paints before it returns.
// Record the decrypt message on the status the composer already reads.
export function rememberLinearCredentialDecryptionError(
  set: LinearSliceSet,
  get: LinearSliceGet,
  error: unknown
): void {
  if (!isIntegrationCredentialDecryptionError(error)) {
    return
  }
  const message =
    error instanceof Error && error.message.trim().length > 0
      ? error.message
      : credentialDecryptionMessage('Linear')
  if (get().linearStatus.credentialError === message) {
    return
  }
  set((state) => ({
    linearStatus: { ...state.linearStatus, credentialError: message }
  }))
}
