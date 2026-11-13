import { vi } from 'vitest'
import { RUNTIME_CAPABILITIES } from '../../../src/shared/protocol-version'
import type { NotificationsApi } from '../../../src/preload/api/desktop-permissions/os-permission-api'

const transport = vi.hoisted(() => ({
  call: vi.fn(),
  away: vi.fn(),
  supports: vi.fn(),
  dismiss: vi.fn(),
  settle: vi.fn(),
  dispatch: vi.fn<NotificationsApi['dispatch']>()
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (original) => ({
  ...(await original()),
  callRuntimeRpc: transport.call
}))
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', async (original) => ({
  ...(await original()),
  runtimeEnvironmentSupportsCapability: transport.supports
}))
vi.mock('@/runtime/hosts/capabilities/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilitiesOrUnknown: () => RUNTIME_CAPABILITIES,
  ensureLocalRuntimeCapabilities: async () => RUNTIME_CAPABILITIES
}))
vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/testing/app-store-test-fixture')
  return { useAppStore: createTestStore() }
})

export { transport }
