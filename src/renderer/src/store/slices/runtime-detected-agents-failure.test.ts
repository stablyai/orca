// A cached [] must not outlive a failed runtime probe, or Quick Launch says
// "No agents detected" for a host it can no longer reach.
import { beforeEach, describe, it, expect, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

const callRuntimeRpc = vi.hoisted(() => vi.fn())

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeRpcClientModule>()
  return { ...actual, callRuntimeRpc }
})

// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: {} }

import { createTestStore } from './store-test-helpers'

describe('runtime detected-agents after a failed probe', () => {
  beforeEach(() => {
    callRuntimeRpc.mockReset()
    callRuntimeRpc.mockRejectedValue(new Error('runtime disconnected'))
  })

  it('drops a cached empty answer when ensure fails', async () => {
    const store = createTestStore()
    store.setState({ runtimeDetectedAgentIds: { 'env-1': [] } })

    await expect(store.getState().ensureRuntimeDetectedAgents('env-1')).resolves.toEqual([])

    expect(store.getState().runtimeDetectedAgentIds).not.toHaveProperty('env-1')
    expect(store.getState().isDetectingRuntimeAgents['env-1']).toBe(false)
  })

  it('drops a cached empty answer when refresh fails', async () => {
    const store = createTestStore()
    store.setState({ runtimeDetectedAgentIds: { 'env-1': [] } })

    await expect(store.getState().refreshRuntimeDetectedAgents('env-1')).resolves.toEqual([])

    expect(store.getState().runtimeDetectedAgentIds).not.toHaveProperty('env-1')
    expect(store.getState().isRefreshingRuntimeAgents['env-1']).toBe(false)
  })

  it('keeps a non-empty last known list when refresh fails', async () => {
    const store = createTestStore()
    store.setState({ runtimeDetectedAgentIds: { 'env-1': ['claude'] } })

    await expect(store.getState().refreshRuntimeDetectedAgents('env-1')).resolves.toEqual([
      'claude'
    ])

    expect(store.getState().runtimeDetectedAgentIds['env-1']).toEqual(['claude'])
  })
})
