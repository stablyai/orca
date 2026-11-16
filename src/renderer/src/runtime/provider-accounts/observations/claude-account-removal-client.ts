import { translate } from '@/i18n/i18n'
import type { ClaudeRateLimitAccountsState } from '../../../../../shared/agent-accounts/managed-account-types'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import { RuntimeRpcCallError } from '../../rpc/calls/runtime-rpc-result'

const REMOTE_ACCOUNT_MUTATION_TIMEOUT_MS = 30_000

export type ClaudeAccountRemoval = {
  deleteRetainedHistory: boolean
  /** The host's Orca deletes the account's conversations anyway; the user was told. */
  hostDeletesHistory: boolean
}

export async function removeClaudeProviderAccount(
  target: RuntimeClientTarget,
  accountId: string,
  removal: ClaudeAccountRemoval,
  hostLabel: string
): Promise<ClaudeRateLimitAccountsState> {
  if (target.kind === 'environment') {
    const options = { timeoutMs: REMOTE_ACCOUNT_MUTATION_TIMEOUT_MS }
    if (removal.hostDeletesHistory) {
      return callRuntimeRpc(target, 'accounts.removeClaude', { accountId }, options)
    }
    return callRuntimeRpc<ClaudeRateLimitAccountsState>(
      target,
      'accounts.removeClaudeWithHistoryChoice',
      { accountId, deleteRetainedHistory: removal.deleteRetainedHistory },
      options
    ).catch((error: unknown) => {
      throw claudeRemovalUnsupportedOnOldHost(error, hostLabel)
    })
  }
  return window.api.claudeAccounts.remove({ accountId, ...removal })
}

/** A host that would delete the conversations refuses the choice; say what to do instead. */
export function claudeRemovalUnsupportedOnOldHost(error: unknown, hostLabel: string): unknown {
  return error instanceof RuntimeRpcCallError && error.code === 'method_not_found'
    ? new Error(
        translate(
          'accounts.claudeRemoval.unsupportedHost',
          'Update Orca on {{host}} to remove this account and keep its conversations.',
          { host: hostLabel }
        )
      )
    : error
}

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
      { timeoutMs: REMOTE_ACCOUNT_MUTATION_TIMEOUT_MS }
    )
  }
  return window.api.claudeAccounts.measureRetainedHistory({ accountId })
}
