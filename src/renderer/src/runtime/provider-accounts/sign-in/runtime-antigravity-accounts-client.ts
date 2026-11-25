import type { AntigravityChatAuthConfig } from '../../../../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import type {
  AntigravityAccountState,
  AntigravityChatSignInIntent,
  AntigravityAccountTarget
} from '../../../../../shared/agent-accounts/antigravity/antigravity-account-types'
import {
  ANTIGRAVITY_ACCOUNTS_RUNTIME_CAPABILITY,
  ANTIGRAVITY_CHAT_SIGN_IN_INTENT_RUNTIME_CAPABILITY,
  ANTIGRAVITY_CHAT_AUTH_CONFIG_RUNTIME_CAPABILITY,
  ANTIGRAVITY_CHAT_AUTH_DETECT_RUNTIME_CAPABILITY,
  ANTIGRAVITY_CHAT_KEY_AND_ADC_AUTH_RUNTIME_CAPABILITY,
  ANTIGRAVITY_CHAT_SIGN_IN_RUNTIME_CAPABILITY
} from '../../../../../shared/remote-runtime/protocol/account-runtime-capabilities'
import type { RuntimeRpcSuccess } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type {
  AntigravityChatApiKeyStatus,
  AntigravityChatAuthDetection
} from '../../../../../shared/rpc-contract/accounts/antigravity-accounts-params'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  assertRuntimeEnvironmentCapability,
  runtimeEnvironmentSupportsCapability
} from '../../rpc/compatibility/runtime-capability-proof'
import { callRuntimeRpc, callRuntimeRpcResponse } from '../../rpc/calls/runtime-rpc-call'
import {
  subscribeRuntimeRpc,
  type RuntimeRpcSubscriptionHandlers
} from '../../rpc/subscriptions/runtime-rpc-subscribe'

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
  params?: { flowId: string; callbackUrl?: string } | { intent: AntigravityChatSignInIntent }
): Promise<RuntimeRpcSuccess<TResult>> {
  await assertChatSignInHost(owner)
  return callRuntimeRpcResponse(owner, `accounts.antigravityChatSignIn${action}`, params, {
    timeoutMs: 20_000,
    ...(action === 'Start'
      ? {
          paramsForStatus: (status) =>
            owner.kind === 'local' ||
            status?.capabilities?.includes(ANTIGRAVITY_CHAT_SIGN_IN_INTENT_RUNTIME_CAPABILITY)
              ? params
              : undefined
        }
      : {})
  })
}

/** The host's sign-in status: a snapshot, then one frame per newer revision. */
export async function subscribeAntigravityChatSignIn(
  owner: RuntimeClientTarget,
  handlers: RuntimeRpcSubscriptionHandlers
): Promise<{ unsubscribe: () => void }> {
  await assertChatSignInHost(owner)
  return subscribeRuntimeRpc(owner, 'accounts.antigravityChatSignInSubscribe', null, {
    ...handlers,
    onEvent: (result, runtimeId) => handlers.onEvent(Object.assign({}, result, { runtimeId }))
  })
}

export async function callAntigravityChatAuthConfig(
  owner: RuntimeClientTarget,
  config?: AntigravityChatAuthConfig
): Promise<AntigravityChatAuthConfig | null> {
  if (owner.kind === 'environment') {
    await assertRuntimeEnvironmentCapability(
      owner.environmentId,
      ANTIGRAVITY_CHAT_AUTH_CONFIG_RUNTIME_CAPABILITY,
      'Update Orca on this host to configure Gemini Enterprise for Antigravity chats.'
    )
  }
  return callRuntimeRpc(
    owner,
    config ? 'accounts.antigravityChatAuthApply' : 'accounts.antigravityChatAuthGet',
    config,
    { timeoutMs: 20_000 }
  )
}

/** Reads, saves or clears the Gemini API key the host's Antigravity chat uses; never returns the key. */
export async function callAntigravityChatApiKey(
  owner: RuntimeClientTarget,
  action: { kind: 'status' } | { kind: 'save'; apiKey: string } | { kind: 'clear' }
): Promise<AntigravityChatApiKeyStatus> {
  if (owner.kind === 'environment') {
    await assertRuntimeEnvironmentCapability(
      owner.environmentId,
      ANTIGRAVITY_CHAT_KEY_AND_ADC_AUTH_RUNTIME_CAPABILITY,
      'Update Orca on this host to sign Antigravity chats in with a Gemini API key.'
    )
  }
  return action.kind === 'save'
    ? callRuntimeRpc(
        owner,
        'accounts.antigravityChatApiKeySave',
        { apiKey: action.apiKey },
        {
          timeoutMs: 20_000
        }
      )
    : callRuntimeRpc(
        owner,
        action.kind === 'clear'
          ? 'accounts.antigravityChatApiKeyClear'
          : 'accounts.antigravityChatApiKeyStatus',
        undefined,
        { timeoutMs: 20_000 }
      )
}

/** The credentials the host's chat could use; null from a host too old to say. */
export async function callAntigravityChatAuthDetect(
  owner: RuntimeClientTarget
): Promise<AntigravityChatAuthDetection | null> {
  if (
    owner.kind === 'environment' &&
    !(await runtimeEnvironmentSupportsCapability(
      owner.environmentId,
      ANTIGRAVITY_CHAT_AUTH_DETECT_RUNTIME_CAPABILITY
    ))
  ) {
    return null
  }
  return callRuntimeRpc(owner, 'accounts.antigravityChatAuthDetect', undefined, {
    timeoutMs: 10_000
  })
}
