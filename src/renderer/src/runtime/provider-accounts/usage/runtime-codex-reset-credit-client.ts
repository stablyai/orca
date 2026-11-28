import type { CodexResetCreditExpectedScope } from '../../../../../shared/agent-accounts/codex/codex-reset-credit-scope'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'
import { CODEX_RESET_CREDIT_RUNTIME_CAPABILITY } from '../../../../../shared/remote-runtime/protocol/account-runtime-capabilities'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import { isLostHostAnswer } from '../sign-in/host-sign-in-lost-answers'
import { runtimeEnvironmentSupportsCapability } from '../../rpc/compatibility/runtime-capability-proof'

// Why: the host waits on Codex's reset endpoint and then refetches usage.
const HOST_RESET_TIMEOUT_MS = 90_000

type HostResetAttempt = { idempotencyKey: string; expectedScope: CodexResetCreditExpectedScope }

// Why module scope: the menu that started an attempt unmounts on close, but its key must outlive it.
const unansweredAttemptByHost = new Map<string, HostResetAttempt>()

export function hostSupportsCodexResetCredit(environmentId: string): Promise<boolean> {
  return runtimeEnvironmentSupportsCapability(environmentId, CODEX_RESET_CREDIT_RUNTIME_CAPABILITY)
}

export function hasUnansweredHostCodexReset(environmentId: string): boolean {
  return unansweredAttemptByHost.has(environmentId)
}

/** Spend one reset credit on the host that owns the account; the host's accounts stream carries the result.
 *  An attempt without a reply is retried with its own key and scope, so the host's ledger never spends twice. */
export async function consumeHostCodexResetCredit(
  environmentId: string,
  scope: CodexResetCreditExpectedScope | null
): Promise<void> {
  const attempt =
    unansweredAttemptByHost.get(environmentId) ??
    (scope ? { idempotencyKey: createBrowserUuid(), expectedScope: scope } : null)
  if (!attempt) {
    return
  }
  unansweredAttemptByHost.set(environmentId, attempt)
  try {
    await callRuntimeRpc(
      { kind: 'environment', environmentId },
      'accounts.consumeCodexResetCredit',
      attempt,
      { timeoutMs: HOST_RESET_TIMEOUT_MS }
    )
  } catch (error) {
    // Why: only a lost answer leaves the outcome unknown; a host refusal is final and a retry starts fresh.
    if (!isLostHostAnswer(error)) {
      unansweredAttemptByHost.delete(environmentId)
    }
    throw error
  }
  unansweredAttemptByHost.delete(environmentId)
}
