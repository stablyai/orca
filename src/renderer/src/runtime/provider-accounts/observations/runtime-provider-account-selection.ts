import type {
  ClaudeAccountSelectResult,
  CodexRateLimitAccountsState
} from '../../../../../shared/agent-accounts/managed-account-types'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import { translate } from '@/i18n/i18n'
import { readClaudeRunningSessionsPolicy } from '@/lib/provider-accounts/claude-account-switch-sessions'
import { REMOTE_ACCOUNT_MUTATION_TIMEOUT_MS } from './runtime-provider-accounts-client'

export type ProviderAccountSelection = {
  accountId: string | null
  runtime: 'host' | 'wsl'
  wslDistro?: string | null
}

export async function selectClaudeProviderAccount(
  target: RuntimeClientTarget,
  selection: ProviderAccountSelection
): Promise<ClaudeAccountSelectResult> {
  if (target.kind === 'environment') {
    // No targeted Claude select RPC: a null ID would clear the host's own slot, not its WSL lane.
    if (selection.runtime === 'wsl' && selection.accountId === null) {
      throw new Error(
        translate(
          'accounts.selection.claudeRemoteWslDefaultUnavailable',
          "Switching this host's WSL lane back to the system default isn't available from here yet."
        )
      )
    }
    return callRuntimeRpc<ClaudeAccountSelectResult>(
      target,
      'accounts.selectClaude',
      // Why the policy: the server's own setting is not the one this app's Settings edits.
      { accountId: selection.accountId, runningSessions: readClaudeRunningSessionsPolicy() },
      { timeoutMs: REMOTE_ACCOUNT_MUTATION_TIMEOUT_MS }
    )
  }
  return window.api.claudeAccounts.select(selection)
}

export async function selectCodexProviderAccount(
  target: RuntimeClientTarget,
  selection: ProviderAccountSelection
): Promise<CodexRateLimitAccountsState> {
  if (target.kind === 'environment') {
    // Plain selectCodex has no target, so a null ID would clear the host slot instead of the WSL lane.
    if (selection.runtime === 'wsl') {
      return callRuntimeRpc<CodexRateLimitAccountsState>(
        target,
        'accounts.selectCodexForTarget',
        {
          accountId: selection.accountId,
          target: { runtime: 'wsl', wslDistro: selection.wslDistro?.trim() || null }
        },
        { timeoutMs: REMOTE_ACCOUNT_MUTATION_TIMEOUT_MS }
      )
    }
    return callRuntimeRpc<CodexRateLimitAccountsState>(
      target,
      'accounts.selectCodex',
      { accountId: selection.accountId },
      { timeoutMs: REMOTE_ACCOUNT_MUTATION_TIMEOUT_MS }
    )
  }
  return window.api.codexAccounts.select(selection)
}
