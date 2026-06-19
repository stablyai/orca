import type { RateLimitRuntimeTarget } from '../../../shared/rate-limit-types'
import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'

/** Resolves the host platform used for quoting resume commands on remote runtimes. */
async function getRemoteHostPlatform(target: RuntimeClientTarget): Promise<NodeJS.Platform> {
  if (target.kind !== 'environment') {
    return CLIENT_PLATFORM
  }
  try {
    const result = await callRuntimeRpc<{ platform: NodeJS.Platform }>(
      target,
      'host.platform',
      undefined,
      { timeoutMs: 5000 }
    )
    return result.platform
  } catch {
    return 'linux'
  }
}

/** Uses Linux shell quoting for WSL accounts and host quoting for everything else. */
export async function resolveAgentRateLimitResumePlatform(args: {
  target: RuntimeClientTarget
  accountTarget: RateLimitRuntimeTarget
}): Promise<NodeJS.Platform> {
  if (args.accountTarget.runtime === 'wsl') {
    return 'linux'
  }
  return getRemoteHostPlatform(args.target)
}
