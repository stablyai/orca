import {
  isRecoverableRemoteRuntimeConnectionError,
  toRemoteRuntimeClientErrorLike,
  type RemoteRuntimeClientErrorLike
} from '../../../../shared/remote-runtime-client-error-classification'

/**
 * What `removeProject` actually did.
 *
 * `owner-unverifiable` is its own answer, not a flavour of failure: no answer arrived from the
 * owning host, so what that host did is **unknown**. It may never have seen the request, or it may
 * have removed the project and lost the reply past the timeout. Neither reading may be asserted
 * (docs/reference/ssh-execution-boundary.md), so a caller must not report the project as removed,
 * must not claim the host still holds it, and must keep its own row — a purge here would state an
 * outcome nobody observed. The one honest action left is the client-only forget, which clears
 * Orca's records and says nothing about the host either way.
 *
 * Retrying once the host answers is safe: `repo.rm` reporting `repo_not_found` is tolerated, so a
 * removal that did land is reconciled instead of failing the second attempt.
 */
export type RemoveProjectOutcome =
  | { status: 'removed' }
  | { status: 'owner-unverifiable' }
  | { status: 'failed' }

const MANUAL_DISCONNECT_CODE = 'runtime_manually_disconnected'
// Producers that raise this untyped put the code or the sentence in the message instead.
const MANUAL_DISCONNECT_MESSAGE_FRAGMENTS: readonly string[] = [
  MANUAL_DISCONNECT_CODE,
  'manually disconnected'
]

/**
 * The client refused to dispatch because the user disconnected this environment, so the request
 * never left the machine and the host answered nothing.
 *
 * Deliberately not added to `RECOVERABLE_CODES`: that set means "retry or reconnect", and it
 * drives the terminal multiplexer's resubscribe, the PTY transport's recovery loop and the remote
 * skill installer's retries. A manual disconnect holds until the user undoes it, so those callers
 * would spin against an environment the user switched off.
 */
function isManuallyDisconnectedOwner(error: RemoteRuntimeClientErrorLike): boolean {
  if (error.code) {
    return error.code === MANUAL_DISCONNECT_CODE
  }
  const message = error.message.toLowerCase()
  return MANUAL_DISCONNECT_MESSAGE_FRAGMENTS.some((fragment) => message.includes(fragment))
}

/**
 * True only when no answer reached us — a dropped transport, a timeout, an unreachable runtime, or
 * a client-side short circuit that never sent the request. A host that answers and refuses —
 * unauthorized, protocol mismatch, an error from its own catalog — is positive evidence and stays
 * a failure.
 */
export function isOwnerContactFailure(error: unknown): boolean {
  const classified = toRemoteRuntimeClientErrorLike(error)
  return (
    isRecoverableRemoteRuntimeConnectionError(classified) || isManuallyDisconnectedOwner(classified)
  )
}
