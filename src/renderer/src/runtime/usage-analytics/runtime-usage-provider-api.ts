import { createUsageProviderApi } from '../../../../preload/usage/usage-provider-api'
import type { PreloadApi } from '../../../../preload/api-types'

type UsageProviderKey = 'claudeUsage' | 'codexUsage' | 'openCodeUsage' | 'museUsage'

// Other reads wait for the host to rescan its transcripts; a first scan outlasts the default timeout.
const USAGE_SCAN_TIMEOUT_MS = 10 * 60_000
const IMMEDIATE_USAGE_ACTIONS = new Set(['getScanState', 'getSnapshot', 'setEnabled'])

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
          IMMEDIATE_USAGE_ACTIONS.has(method.slice(method.indexOf(':') + 1))
            ? undefined
            : USAGE_SCAN_TIMEOUT_MS
        )
    },
    prefix
  )
}
