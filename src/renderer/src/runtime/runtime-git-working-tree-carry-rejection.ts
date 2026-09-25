import { hasRuntimeRpcErrorCode } from '../../../shared/runtime-rpc-error-code'
import type { WorkingTreeCarryFailureReason } from '../../../shared/working-tree-change-carry'

// Why: each reports lost contact after the request may have reached the host, so the carry may have run.
const CONTACT_LOST_CODES = [
  'runtime_timeout',
  'timeout',
  'reconnecting',
  'remote_runtime_unavailable'
] as const

// Why: the request socket drops a queued request before writing it, so nothing ran on the host.
const NEVER_SENT_MESSAGE = 'released before it could be sent'

/** Maps a rejected carry call to "nothing written" or "outcome unknown" (ssh-execution-boundary). */
export function classifyWorkingTreeCarryRejection(
  error: unknown
): Extract<WorkingTreeCarryFailureReason, 'apply_failed' | 'partially_applied'> {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes(NEVER_SENT_MESSAGE)) {
    return 'apply_failed'
  }
  return CONTACT_LOST_CODES.some((code) => hasRuntimeRpcErrorCode(error, code))
    ? 'partially_applied'
    : 'apply_failed'
}
