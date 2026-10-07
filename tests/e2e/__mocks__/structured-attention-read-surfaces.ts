import { vi } from 'vitest'
import { RUNTIME_CAPABILITIES } from '../../../src/shared/protocol-version'

const transport = vi.hoisted(() => ({
  call: vi.fn(),
  away: vi.fn(),
  supports: vi.fn(),
  dismiss: vi.fn(),
  settle: vi.fn(),
  dispatch: vi.fn()
}))
vi.mock('@/runtime/runtime-rpc-client', async (original) => ({
  ...(await original()),
  callRuntimeRpc: transport.call,
  runtimeEnvironmentSupportsCapability: transport.supports
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilitiesOrUnknown: () => RUNTIME_CAPABILITIES,
  ensureLocalRuntimeCapabilities: async () => RUNTIME_CAPABILITIES
}))
vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  return { useAppStore: createTestStore() }
})

export { transport }
