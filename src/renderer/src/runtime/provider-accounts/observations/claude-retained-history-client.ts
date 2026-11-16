import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

/** Size of the conversations only this account holds; older hosts reject with method_not_found. */
export async function measureClaudeRetainedHistory(
  target: RuntimeClientTarget,
  accountId: string
): Promise<{ bytes: number }> {
  if (target.kind === 'environment') {
    return callRuntimeRpc<{ bytes: number }>(
      target,
      'accounts.measureClaudeRetainedHistory',
      { accountId },
      { timeoutMs: 30_000 }
    )
  }
  return window.api.claudeAccounts.measureRetainedHistory({ accountId })
}
