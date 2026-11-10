import type { StoreCascadesMockApi } from '../testing/app-store-cascade-api.test-fixture'

import { createCompatibleRuntimeStatusResponseIfNeeded } from '../../runtime/rpc/testing/runtime-compatibility-test-fixture'

/** Runtime RPC default for the sleep suites: compat probes pass through, terminal.sleep reports a clean stop. */
export function applySleepRuntimeRpcDefault(mockApi: StoreCascadesMockApi): void {
  mockApi.runtime.call.mockImplementation(
    async (args: { params?: { command?: { paneKeys?: string[] } } }) => ({
      id: 'local-sleep',
      ok: true,
      result: { ok: true, result: { slept: args.params?.command?.paneKeys ?? [] } }
    })
  )
  mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) =>
    Promise.resolve(
      createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
        id: 'rpc-default',
        ok: true,
        result:
          args.method === 'terminal.sleep'
            ? {
                stopped: 0,
                stoppedPtyIds: [],
                livePtyIds: [],
                postStopVerified: true
              }
            : {},
        _meta: { runtimeId: 'remote-runtime' }
      }
    )
  )
}
