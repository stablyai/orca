import { RUNTIME_RPC_QUEUE_OVERLOAD_CODE } from '../../../shared/remote-runtime-client-error-classification'
import { hasRuntimeRpcErrorCode } from '../../../shared/runtime-rpc-error-code'
import type { WorkingTreeCarryFailureReason } from '../../../shared/working-tree-change-carry'

// Why: each is refused before the host dispatches the carry, so nothing was written.
const NEVER_RAN_CODES = [
  RUNTIME_RPC_QUEUE_OVERLOAD_CODE,
  'method_not_found',
  'method_not_supported',
  'invalid_argument',
  'invalid_params',
  'capability_unsupported',
  'selector_not_found',
  'selector_ambiguous',
  'unauthorized'
] as const

// Why: the request socket drops a queued request before writing it; an older SSH relay has no handler.
const NEVER_RAN_MESSAGES = ['released before it could be sent', 'Method not found: '] as const

/** Maps a rejected carry call to "nothing written" or "outcome unknown" (ssh-execution-boundary). */
export function classifyWorkingTreeCarryRejection(
  error: unknown
): Extract<WorkingTreeCarryFailureReason, 'apply_failed' | 'partially_applied'> {
  const message = error instanceof Error ? error.message : String(error)
  if (NEVER_RAN_MESSAGES.some((fragment) => message.includes(fragment))) {
    return 'apply_failed'
  }
  // Why: lost contact is never evidence the carry did not run, so only known pre-dispatch refusals are definite.
  return NEVER_RAN_CODES.some((code) => hasRuntimeRpcErrorCode(error, code))
    ? 'apply_failed'
    : 'partially_applied'
}
