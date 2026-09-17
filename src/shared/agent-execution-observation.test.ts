import { describe, expect, it, vi } from 'vitest'
import {
  AgentExecutionObservationScheduler,
  parseAgentExecutionObservation,
  resolveAgentStatusPresentation,
  type AgentExecutionHostInventory
} from './agent-execution-observation'

const HOST = 'local' as const

function attachment(executionId: string, processIncarnation: string) {
  return {
    executionId,
    hostId: HOST,
    hostEpoch: 'epoch-1',
    processIncarnation
  }
}

function inventory(
  processIncarnations: readonly string[],
  coverage: AgentExecutionHostInventory['inventoryCoverage'] = 'complete'
): AgentExecutionHostInventory {
  return {
    hostId: HOST,
    hostEpoch: 'epoch-1',
    capturedAt: 1_000,
    inventoryCoverage: coverage,
    processIncarnations: new Set(processIncarnations)
  }
}

describe('agent execution observation decoder', () => {
  it('accepts complete host evidence and rejects malformed or unknown fields', () => {
    const value = {
      executionId: 'exec-1',
      hostId: 'local',
      hostEpoch: 'epoch-1',
      captureRevision: 1,
      observedAt: 1_000,
      inventoryCoverage: 'complete',
      verdict: 'live'
    }
    expect(parseAgentExecutionObservation(value)).toEqual(value)
    expect(parseAgentExecutionObservation({ ...value, extra: true })).toBeNull()
    expect(
      parseAgentExecutionObservation({ ...value, verdict: 'exited', captureRevision: 0 })
    ).toBeNull()
    expect(parseAgentExecutionObservation({ ...value, hostId: 'ssh:' })).toBeNull()
  })
})

describe('AgentExecutionObservationScheduler', () => {
  it('coalesces same-host requests and publishes a revision for unchanged rows', async () => {
    vi.useFakeTimers()
    try {
      let resolveScan!: (value: AgentExecutionHostInventory) => void
      const scanHost = vi.fn(
        () =>
          new Promise<AgentExecutionHostInventory>((resolve) => {
            resolveScan = resolve
          })
      )
      const published: unknown[] = []
      const scheduler = new AgentExecutionObservationScheduler(scanHost, (observation) => {
        published.push(observation)
      })
      scheduler.register(attachment('exec-a', 'pty-a:1'))
      scheduler.register(attachment('exec-b', 'pty-b:1'))
      const first = scheduler.request('exec-a')
      const second = scheduler.request('exec-b')

      await vi.advanceTimersByTimeAsync(25)
      expect(scanHost).toHaveBeenCalledTimes(1)
      resolveScan(inventory(['pty-a:1']))
      await vi.runAllTicks()

      await expect(first).resolves.toMatchObject({
        executionId: 'exec-a',
        verdict: 'live',
        captureRevision: 1
      })
      await expect(second).resolves.toMatchObject({
        executionId: 'exec-b',
        verdict: 'exited',
        captureRevision: 1
      })
      expect(published).toHaveLength(2)

      const repeat = scheduler.request('exec-a')
      await vi.advanceTimersByTimeAsync(25)
      resolveScan(inventory(['pty-a:1']))
      await vi.runAllTicks()
      await expect(repeat).resolves.toMatchObject({
        executionId: 'exec-a',
        verdict: 'live',
        captureRevision: 2
      })
      expect(scanHost).toHaveBeenCalledTimes(2)
      scheduler.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('never converts incomplete inventory or pid reuse into a live verdict', async () => {
    vi.useFakeTimers()
    try {
      let resolveScan!: (value: AgentExecutionHostInventory) => void
      const scheduler = new AgentExecutionObservationScheduler(
        () =>
          new Promise<AgentExecutionHostInventory>((resolve) => {
            resolveScan = resolve
          }),
        () => undefined
      )
      scheduler.register(attachment('exec-a', 'pty-a:1'))
      const result = scheduler.request('exec-a')
      await vi.advanceTimersByTimeAsync(25)
      resolveScan(inventory(['pty-a:2']))
      await vi.runAllTicks()
      await expect(result).resolves.toMatchObject({ verdict: 'exited' })

      scheduler.register(attachment('exec-a', 'pty-a:3'))
      const incomplete = scheduler.request('exec-a')
      await vi.advanceTimersByTimeAsync(25)
      resolveScan(inventory([], 'partial'))
      await vi.runAllTicks()
      await expect(incomplete).resolves.toMatchObject({ verdict: 'unverifiable' })
      scheduler.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles pending requests for a replaced attachment and ignores its delayed scan', async () => {
    vi.useFakeTimers()
    try {
      let resolveScan!: (value: AgentExecutionHostInventory) => void
      const scheduler = new AgentExecutionObservationScheduler(
        () =>
          new Promise<AgentExecutionHostInventory>((resolve) => {
            resolveScan = resolve
          }),
        () => undefined
      )
      scheduler.register(attachment('exec-a', 'pty-a:1'))
      const oldRequest = scheduler.request('exec-a')
      await vi.advanceTimersByTimeAsync(25)
      scheduler.register(attachment('exec-a', 'pty-a:2'))
      await expect(oldRequest).resolves.toMatchObject({ verdict: 'unverifiable' })
      resolveScan(inventory(['pty-a:1']))
      await vi.runAllTicks()
      expect(scheduler.getPublished('exec-a')).toBeUndefined()
      scheduler.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles a pending request when its attachment is unregistered', async () => {
    vi.useFakeTimers()
    try {
      const scheduler = new AgentExecutionObservationScheduler(
        () => new Promise<AgentExecutionHostInventory>(() => {}),
        () => undefined
      )
      scheduler.register(attachment('exec-a', 'pty-a:1'))
      const result = scheduler.request('exec-a')
      scheduler.unregister('exec-a')
      await expect(result).resolves.toMatchObject({
        executionId: 'exec-a',
        verdict: 'unverifiable'
      })
      scheduler.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a failed host scan with bounded backoff after returning uncertainty', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const scanHost = vi.fn(async () => {
        calls += 1
        if (calls === 1) {
          throw new Error('relay_unavailable')
        }
        return inventory(['pty-a:1'])
      })
      const published: unknown[] = []
      const scheduler = new AgentExecutionObservationScheduler(
        scanHost,
        (observation) => {
          published.push(observation)
        },
        { retryBaseMs: 10, retryMaxMs: 20 }
      )
      scheduler.register(attachment('exec-a', 'pty-a:1'))
      const result = scheduler.request('exec-a')
      await vi.advanceTimersByTimeAsync(25)
      await expect(result).resolves.toMatchObject({ verdict: 'unverifiable' })
      expect(calls).toBe(1)
      await vi.advanceTimersByTimeAsync(10)
      await vi.advanceTimersByTimeAsync(25)
      expect(calls).toBe(2)
      expect(published.toReversed()[0]).toMatchObject({ verdict: 'live', captureRevision: 2 })
      scheduler.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('resolveAgentStatusPresentation', () => {
  it('retains a legacy pending question without allowing the clock to resolve it', () => {
    expect(
      resolveAgentStatusPresentation(
        { state: 'blocked', updatedAt: 0 },
        31 * 60 * 1_000,
        30 * 60 * 1_000
      )
    ).toEqual({
      state: 'blocked',
      executionVerdict: null,
      pendingInteraction: true,
      confidence: 'legacy',
      routeUsability: 'unverifiable'
    })
  })

  it('retains a pending question through contact uncertainty and never treats liveness as Working', () => {
    const pending = resolveAgentStatusPresentation(
      {
        state: 'waiting',
        updatedAt: 0,
        executionObservation: {
          executionId: 'exec-1',
          hostId: HOST,
          hostEpoch: 'epoch-1',
          captureRevision: 3,
          observedAt: 0,
          inventoryCoverage: 'partial',
          verdict: 'unverifiable'
        }
      },
      31 * 60 * 1_000,
      30 * 60 * 1_000
    )
    expect(pending).toMatchObject({
      state: 'waiting',
      pendingInteraction: true,
      confidence: 'uncertain',
      routeUsability: 'usable'
    })

    const working = resolveAgentStatusPresentation(
      {
        state: 'working',
        updatedAt: 0,
        executionObservation: {
          executionId: 'exec-1',
          hostId: HOST,
          hostEpoch: 'epoch-1',
          captureRevision: 3,
          observedAt: 0,
          inventoryCoverage: 'complete',
          verdict: 'live'
        }
      },
      31 * 60 * 1_000,
      30 * 60 * 1_000
    )
    expect(working).toMatchObject({ state: 'unverifiable', executionVerdict: 'live' })
  })
})
