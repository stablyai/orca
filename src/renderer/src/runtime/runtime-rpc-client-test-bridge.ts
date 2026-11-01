import { beforeEach, vi } from 'vitest'
import type { Mock } from 'vitest'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'

export const runtimeCall: Mock = vi.fn()
export const runtimeEnvironmentCall: Mock = vi.fn()
export const runtimeEnvironmentSubscribe: Mock = vi.fn()

export function installRuntimeRpcClientTestBridge(): void {
  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
    runtimeCall.mockReset()
    runtimeEnvironmentCall.mockReset()
    runtimeEnvironmentSubscribe.mockReset()
    vi.stubGlobal('window', {
      api: {
        runtime: { call: runtimeCall },
        runtimeEnvironments: {
          call: runtimeEnvironmentCall,
          cancelSubscription: vi.fn().mockResolvedValue(undefined),
          subscribe: runtimeEnvironmentSubscribe
        }
      }
    })
  })
}
