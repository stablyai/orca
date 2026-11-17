import type { CodexResetCreditExpectedScope } from '../../../../../shared/agent-accounts/codex/codex-reset-credit-scope'
import { CODEX_RESET_CREDIT_RUNTIME_CAPABILITY } from '../../../../../shared/remote-runtime/protocol/account-runtime-capabilities'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import { runtimeEnvironmentSupportsCapability } from '../../rpc/compatibility/runtime-capability-proof'

// Why: the host waits on Codex's reset endpoint and then refetches usage.
const HOST_RESET_TIMEOUT_MS = 90_000

export function hostSupportsCodexResetCredit(environmentId: string): Promise<boolean> {
  return runtimeEnvironmentSupportsCapability(environmentId, CODEX_RESET_CREDIT_RUNTIME_CAPABILITY)
}

/** Spend one reset credit on the host that owns the account; the host's accounts stream carries the result. */
export async function consumeHostCodexResetCredit(
  environmentId: string,
  attempt: { idempotencyKey: string; expectedScope: CodexResetCreditExpectedScope }
): Promise<void> {
  await callRuntimeRpc(
    { kind: 'environment', environmentId },
    'accounts.consumeCodexResetCredit',
    attempt,
    { timeoutMs: HOST_RESET_TIMEOUT_MS }
  )
}
