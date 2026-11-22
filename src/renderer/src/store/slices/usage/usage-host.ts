import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { callRuntimeRpc } from '../../../runtime/rpc/calls/runtime-rpc-call'
import { createRuntimeUsageProviderApi } from '../../../runtime/usage-analytics/runtime-usage-provider-api'
import type { PreloadApi } from '../../../../../preload/api-types'

type UsageProviderKey =
  | 'claudeUsage'
  | 'codexUsage'
  | 'openCodeUsage'
  | 'museUsage'
  | 'mistralVibeUsage'

/** Identifies the host whose usage Stats & Usage shows. */
export function usageHostKey(target: RuntimeClientTarget): string {
  return target.kind === 'environment' ? `environment:${target.environmentId}` : 'local'
}

/** This computer's usage comes from its own backend; a remote host computes its own and answers over RPC. */
export function usageApiForHost<Key extends UsageProviderKey>(
  target: RuntimeClientTarget,
  key: Key
): PreloadApi[Key] {
  if (target.kind === 'local') {
    return window.api[key]
  }
  return createRuntimeUsageProviderApi(
    (method, params, timeoutMs) => callRuntimeRpc(target, method, params, { timeoutMs }),
    key
  )
}
