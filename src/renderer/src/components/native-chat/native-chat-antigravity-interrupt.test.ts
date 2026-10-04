import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { createNativeChatAntigravityInterrupt } from './native-chat-antigravity-interrupt'

const paneKey = 'tab:11111111-1111-4111-8111-111111111111'

function working(): AgentStatusEntry {
  return {
    paneKey,
    state: 'working',
    agentType: 'antigravity',
    prompt: 'bounded task',
    updatedAt: Date.now(),
    stateStartedAt: Date.now(),
    stateHistory: [],
    observation: {
      origin: 'hook',
      authorityId: 'host',
      incarnation: 1,
      revision: 2,
      observedAt: Date.now()
    }
  }
}

function harness() {
  let current = working()
  const delivery = Promise.withResolvers<boolean>()
  const inferInterrupt = vi.fn(async () => true)
  const interrupt = createNativeChatAntigravityInterrupt({
    paneKey,
    getStatusEntry: () => current,
    writeAccepted: () => delivery.promise,
    inferInterrupt
  })
  return {
    interrupt,
    delivery,
    inferInterrupt,
    replace: (row: AgentStatusEntry) => (current = row)
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('acknowledged Antigravity Chat interruption', () => {
  it('reuses the captured canonical turn only after accepted delivery and the existing settle delay', async () => {
    const { interrupt, delivery, inferInterrupt } = harness()
    const cancelling = interrupt.cancel()
    await vi.advanceTimersByTimeAsync(1000)
    expect(inferInterrupt).not.toHaveBeenCalled()
    delivery.resolve(true)
    await cancelling
    await vi.advanceTimersByTimeAsync(499)
    expect(inferInterrupt).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(inferInterrupt).toHaveBeenCalledExactlyOnceWith({
      paneKey,
      baselineAgentType: 'antigravity',
      baselinePrompt: 'bounded task',
      baselineUpdatedAt: expect.any(Number),
      baselineStateStartedAt: expect.any(Number),
      intent: 'plain-escape'
    })
    interrupt.dispose()
  })

  it('never treats refused delivery as success', async () => {
    const { interrupt, delivery, inferInterrupt } = harness()
    const cancelling = interrupt.cancel()
    delivery.resolve(false)
    await cancelling
    await vi.advanceTimersByTimeAsync(1000)
    expect(inferInterrupt).not.toHaveBeenCalled()
    interrupt.dispose()
  })

  it('propagates unavailable delivery without inferring a stopped agent', async () => {
    const { interrupt, delivery, inferInterrupt } = harness()
    const cancelling = interrupt.cancel()
    delivery.reject(new Error('transport unavailable'))
    await expect(cancelling).rejects.toThrow('transport unavailable')
    await vi.advanceTimersByTimeAsync(1000)
    expect(inferInterrupt).not.toHaveBeenCalled()
    interrupt.dispose()
  })

  it.each(['before acknowledgement', 'after acknowledgement'])(
    'rejects target rebinding/unmount %s',
    async (when) => {
      const { interrupt, delivery, inferInterrupt } = harness()
      const cancelling = interrupt.cancel()
      if (when === 'before acknowledgement') {
        interrupt.dispose()
      }
      delivery.resolve(true)
      await cancelling
      interrupt.dispose()
      await vi.advanceTimersByTimeAsync(1000)
      expect(inferInterrupt).not.toHaveBeenCalled()
    }
  )

  it.each(['authorityId', 'incarnation', 'revision'] as const)(
    'rejects a changed canonical %s even when turn timestamps match',
    async (field) => {
      const { interrupt, delivery, inferInterrupt, replace } = harness()
      const row = working()
      replace(row)
      const cancelling = interrupt.cancel()
      delivery.resolve(true)
      await cancelling
      if (!row.observation) {
        throw new Error('Missing observation')
      }
      row.observation = {
        ...row.observation,
        [field]: field === 'authorityId' ? 'other-host' : 3
      }
      await vi.advanceTimersByTimeAsync(1000)
      expect(inferInterrupt).not.toHaveBeenCalled()
      interrupt.dispose()
    }
  )

  it.each(['waiting', 'done'] as const)('does not cancel a %s baseline', async (state) => {
    const { interrupt, delivery, inferInterrupt, replace } = harness()
    replace({ ...working(), state })
    const cancelling = interrupt.cancel()
    delivery.resolve(true)
    await cancelling
    await vi.advanceTimersByTimeAsync(1000)
    expect(inferInterrupt).not.toHaveBeenCalled()
    interrupt.dispose()
  })

  it('refuses old rows without canonical observation identity', async () => {
    const { interrupt, delivery, inferInterrupt, replace } = harness()
    replace({ ...working(), observation: undefined })
    const cancelling = interrupt.cancel()
    delivery.resolve(true)
    await cancelling
    await vi.advanceTimersByTimeAsync(1000)
    expect(inferInterrupt).not.toHaveBeenCalled()
    interrupt.dispose()
  })

  it('does not mint a replacement turn baseline when delivery acknowledges late', async () => {
    const { interrupt, delivery, inferInterrupt, replace } = harness()
    const cancelling = interrupt.cancel()
    replace({ ...working(), prompt: 'replacement turn' })
    delivery.resolve(true)
    await cancelling
    await vi.advanceTimersByTimeAsync(1000)
    expect(inferInterrupt).not.toHaveBeenCalled()
    interrupt.dispose()
  })
})
