import { callRuntimeRpc } from './runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

export type UsageAnalyticsProvider = 'claude' | 'codex' | 'opencode' | 'muse'

/** The desktop usage IPC surface the Stats & Usage slices read; a server answers the same calls. */
export type UsageAnalyticsApi<ScanState, Snapshot, Scope extends string, Range extends string> = {
  getScanState: () => Promise<ScanState>
  setEnabled: (args: { enabled: boolean }) => Promise<ScanState>
  refresh: (args?: { force?: boolean }) => Promise<ScanState>
  getSnapshot: (args: { scope: Scope; range: Range; limit?: number }) => Promise<Snapshot>
}

// Why: refresh resolves when the scan finishes, and a server's first scan of a long history takes minutes.
const REMOTE_USAGE_REFRESH_TIMEOUT_MS = 10 * 60_000

export function createRuntimeUsageAnalyticsApi<
  ScanState,
  Snapshot,
  Scope extends string,
  Range extends string
>(
  target: Extract<RuntimeClientTarget, { kind: 'environment' }>,
  provider: UsageAnalyticsProvider
): UsageAnalyticsApi<ScanState, Snapshot, Scope, Range> {
  return {
    getScanState: () => callRuntimeRpc<ScanState>(target, 'usage.getScanState', { provider }),
    setEnabled: ({ enabled }) =>
      callRuntimeRpc<ScanState>(target, 'usage.setEnabled', { provider, enabled }),
    refresh: (args) =>
      callRuntimeRpc<ScanState>(
        target,
        'usage.refresh',
        { provider, force: args?.force ?? false },
        { timeoutMs: REMOTE_USAGE_REFRESH_TIMEOUT_MS }
      ),
    getSnapshot: ({ scope, range, limit }) =>
      callRuntimeRpc<Snapshot>(target, 'usage.getSnapshot', { provider, scope, range, limit })
  }
}
