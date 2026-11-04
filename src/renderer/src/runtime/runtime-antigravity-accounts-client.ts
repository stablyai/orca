import type {
  AntigravityAccountState,
  AntigravityAccountTarget
} from '../../../shared/antigravity-account-types'
import {
  ANTIGRAVITY_ACCOUNTS_RUNTIME_CAPABILITY,
  ANTIGRAVITY_CHAT_SIGN_IN_RUNTIME_CAPABILITY
} from '../../../shared/account-runtime-capabilities'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { assertRuntimeEnvironmentCapability, callRuntimeRpc } from './runtime-rpc-client'
import { subscribeRuntimeRpc, type RuntimeRpcSubscriptionHandlers } from './runtime-rpc-subscribe'

export async function callAntigravityAccounts(
  owner: RuntimeClientTarget,
  target: AntigravityAccountTarget,
  action: 'List' | 'AddCurrent' | 'Select' | 'Remove',
  accountId?: string
): Promise<AntigravityAccountState> {
  if (owner.kind === 'environment') {
    await assertRuntimeEnvironmentCapability(
      owner.environmentId,
      ANTIGRAVITY_ACCOUNTS_RUNTIME_CAPABILITY,
      'This execution host does not support native Antigravity Accounts yet. Update Orca on that host.'
    )
  }
  return callRuntimeRpc(
    owner,
    `accounts.antigravity${action}`,
    action === 'List' || action === 'AddCurrent' ? target : { target, accountId },
    { timeoutMs: 20_000 }
  )
}

async function assertChatSignInHost(owner: RuntimeClientTarget): Promise<void> {
  if (owner.kind === 'environment') {
    await assertRuntimeEnvironmentCapability(
      owner.environmentId,
      ANTIGRAVITY_CHAT_SIGN_IN_RUNTIME_CAPABILITY,
      'This execution host does not support Antigravity chat sign-in yet. Update Orca on that host.'
    )
  }
}

export async function callAntigravityChatSignIn<TResult>(
  owner: RuntimeClientTarget,
  action: 'Start' | 'Cancel' | 'Complete',
  params?: { flowId: string; callbackUrl?: string }
): Promise<TResult> {
  await assertChatSignInHost(owner)
  return callRuntimeRpc(owner, `accounts.antigravityChatSignIn${action}`, params, {
    timeoutMs: 20_000
  })
}

/** The host's sign-in status: a snapshot, then one frame per newer revision. */
export async function subscribeAntigravityChatSignIn(
  owner: RuntimeClientTarget,
  handlers: RuntimeRpcSubscriptionHandlers
): Promise<{ unsubscribe: () => void }> {
  await assertChatSignInHost(owner)
  return subscribeRuntimeRpc(owner, 'accounts.antigravityChatSignInSubscribe', null, handlers)
}
