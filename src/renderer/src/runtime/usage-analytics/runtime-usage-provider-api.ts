import { createUsageProviderApi } from '../../../../preload/usage/usage-provider-api'
import type { PreloadApi } from '../../../../preload/api-types'

type UsageProviderKey = 'claudeUsage' | 'codexUsage' | 'openCodeUsage' | 'museUsage'

// A refresh waits for the host to read every transcript; a first scan outlasts the default timeout.
const USAGE_REFRESH_TIMEOUT_MS = 10 * 60_000

export type RuntimeUsageCaller = (
  method: string,
  params: unknown,
  timeoutMs?: number
) => Promise<unknown>

/** A host's usage, computed by the host that holds the transcripts and read over runtime RPC. */
export function createRuntimeUsageProviderApi<Key extends UsageProviderKey>(
  call: RuntimeUsageCaller,
  prefix: Key
): PreloadApi[Key] {
  return createUsageProviderApi(
    {
      invoke: (method, params) =>
        call(
          'usage.call',
          { method, params },
          method.endsWith(':refresh') ? USAGE_REFRESH_TIMEOUT_MS : undefined
        )
    },
    prefix
  )
}
