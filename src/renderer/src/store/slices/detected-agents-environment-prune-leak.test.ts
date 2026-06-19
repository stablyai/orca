/**
 * Memory-leak regression: runtime detected-agent caches must be evicted when a
 * runtime environment is removed.
 *
 * `runtimeDetectedAgentIds` and `isDetectingRuntimeAgents` are keyed by runtime
 * environmentId and gain an entry per environment that opens its tab-bar launch
 * menu. The only removal action (`clearRuntimeDetectedAgents`) had no production
 * caller, so removed environments leaked their entries for the renderer session.
 * `setRuntimeEnvironments` now prunes them to the surviving environment set.
 */
import { describe, it, expect, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'

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

// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: {} }

import { createTestStore } from './store-test-helpers'

function env(id: string): PublicKnownRuntimeEnvironment {
  return { id } as unknown as PublicKnownRuntimeEnvironment
}

describe('runtime detected-agents pruned on environment removal (leak regression)', () => {
  it('drops detected-agent caches for environments that no longer exist', () => {
    const store = createTestStore()
    store.setState({
      runtimeDetectedAgentIds: { 'env-1': [], 'env-2': [] },
      isDetectingRuntimeAgents: { 'env-1': false, 'env-2': true }
    })

    // env-2 is removed from the runtime environment list.
    store.getState().setRuntimeEnvironments([env('env-1')])

    const s = store.getState()
    expect(s.runtimeDetectedAgentIds).not.toHaveProperty('env-2')
    expect(s.isDetectingRuntimeAgents).not.toHaveProperty('env-2')
    // Surviving environment is preserved.
    expect(s.runtimeDetectedAgentIds).toHaveProperty('env-1')
    expect(s.isDetectingRuntimeAgents['env-1']).toBe(false)
  })

  it('retainRuntimeDetectedAgents keeps only the listed environments', () => {
    const store = createTestStore()
    store.setState({
      runtimeDetectedAgentIds: { a: [], b: [], c: [] },
      isDetectingRuntimeAgents: { a: false, b: false, c: false }
    })

    store.getState().retainRuntimeDetectedAgents(['b'])

    const s = store.getState()
    expect(Object.keys(s.runtimeDetectedAgentIds)).toEqual(['b'])
    expect(Object.keys(s.isDetectingRuntimeAgents)).toEqual(['b'])
  })
})
