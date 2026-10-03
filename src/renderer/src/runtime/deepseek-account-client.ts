import {
  DEEPSEEK_BALANCE_CAPABILITY,
  unsupportedDeepSeekAccount,
  type DeepSeekAccountStatus
} from '../../../shared/deepseek-balance'
import type { RateLimitState } from '../../../shared/rate-limit-types'
import { ensureLocalRuntimeCapabilities } from './local-runtime-capabilities'
import {
  callRuntimeRpc,
  runtimeEnvironmentSupportsCapability,
  type RuntimeClientTarget
} from './runtime-rpc-client'

async function supportsDeepSeek(target: RuntimeClientTarget): Promise<boolean> {
  return target.kind === 'local'
    ? (await ensureLocalRuntimeCapabilities())?.includes(DEEPSEEK_BALANCE_CAPABILITY) === true
    : runtimeEnvironmentSupportsCapability(target.environmentId, DEEPSEEK_BALANCE_CAPABILITY)
}

export async function readDeepSeekAccount(
  target: RuntimeClientTarget
): Promise<DeepSeekAccountStatus> {
  if (!(await supportsDeepSeek(target))) {
    return unsupportedDeepSeekAccount()
  }
  return callRuntimeRpc<DeepSeekAccountStatus>(target, 'accounts.deepSeekStatus')
}

export async function mutateDeepSeekAccount(
  target: RuntimeClientTarget,
  ownerId: string,
  action: 'save' | 'remove',
  apiKey?: string
): Promise<DeepSeekAccountStatus> {
  if (!(await supportsDeepSeek(target))) {
    throw new Error('DeepSeek accounts are unsupported on this host')
  }
  return callRuntimeRpc<DeepSeekAccountStatus>(
    target,
    action === 'save' ? 'accounts.saveDeepSeekApiKey' : 'accounts.removeDeepSeekApiKey',
    { ownerId, ...(action === 'save' ? { apiKey } : {}) },
    { expectedEnvironmentRuntimeId: ownerId }
  )
}

export async function refreshDeepSeekAccount(
  target: RuntimeClientTarget,
  ownerId: string
): Promise<RateLimitState> {
  if (!(await supportsDeepSeek(target))) {
    throw new Error('DeepSeek accounts are unsupported on this host')
  }
  return callRuntimeRpc<RateLimitState>(
    target,
    'accounts.refreshDeepSeek',
    { ownerId },
    {
      timeoutMs: 20_000,
      expectedEnvironmentRuntimeId: ownerId
    }
  )
}
