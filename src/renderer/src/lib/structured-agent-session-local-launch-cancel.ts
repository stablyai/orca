import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { hasRuntimeRpcErrorCode } from '../../../shared/runtime-rpc-error-code'
import { retireStructuredAgentSessionTab } from '@/runtime/structured-agent-session-tab-retirement'
import {
  deleteStructuredAgentLaunchRecord,
  hasStructuredAgentLaunchCancellationTombstonePersisted
} from './structured-agent-session-launch-persistence'
import { markStructuredAgentLaunchCancellation } from './launch-cancel-tombstones-compat/structured-agent-session-launch-cancellation'

/**
 * ORCA_LAYOUT_OWNER=main only: this machine's host refuses a create whose close came first, or
 * closes the chat as it lands, so a local cancel retires the chat on the host at once instead of
 * keeping a tombstone until the host lists it. A host that cannot be told gets the tombstone.
 */
export function cancelStructuredAgentLaunchOnLocalHost(
  worktreeId: string,
  sessionId: string,
  onTombstoned: () => void,
  launchPromise?: Promise<unknown>
): void {
  deleteStructuredAgentLaunchRecord(sessionId)
  void retireStructuredAgentSessionTab({
    target: { kind: 'local' },
    worktreeId,
    sessionId,
    onError: (error) => {
      // A create that has not landed has no host tab yet; main still heard the close.
      if (hasRuntimeRpcErrorCode(error, 'tab_not_found')) {
        return
      }
      markStructuredAgentLaunchCancellation(
        sessionId,
        LOCAL_EXECUTION_HOST_ID,
        hasStructuredAgentLaunchCancellationTombstonePersisted(sessionId),
        launchPromise
      )
      onTombstoned()
    }
  })
}
