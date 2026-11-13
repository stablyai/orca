import { afterEach, expect, it, vi } from 'vitest'
import { createCompatibleRuntimeStatusResponse } from '../../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { stubRuntimeEnvironmentBridge } from '../../../runtime/rpc/testing/runtime-environment-bridge-fixture'
import { resolvePRDetailRecoveryTransport } from './pr-detail-recovery-transport'

afterEach(() => vi.unstubAllGlobals())

it('leaves recovery to Open/Retry when the paired host only supports the older ticket contract', async () => {
  const status = createCompatibleRuntimeStatusResponse('older-host')
  stubRuntimeEnvironmentBridge({
    call: async () => ({
      ...status,
      result: { ...status.result, capabilities: ['github.pr-detail-recovery.v1'] }
    })
  })
  expect(await resolvePRDetailRecoveryTransport('older-host')).toBeNull()
})
