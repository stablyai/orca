import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SshConnectionState, SshProviderEpoch } from '../../../shared/ssh-types'
import {
  SshStartupReconnectScheduler,
  type SshStartupReconnectBatchResult
} from './ssh-startup-reconnect'
import {
  startSshStartupReconnect,
  type SshStartupReconnectOrchestrationArgs
} from './ssh-startup-reconnect-orchestration'

function connectedState(targetId: string): SshConnectionState {
  return {
    targetId,
    status: 'connected',
    error: null,
    reconnectAttempt: 0,
    providerEpoch: 'startup-provider-epoch' as SshProviderEpoch,
    connectionGeneration: 1,
    remotePlatform: 'linux'
  }
}

function disconnectedState(targetId: string): SshConnectionState {
  return {
    targetId,
    status: 'disconnected',
    error: 'Authentication failed',
    reconnectAttempt: 1,
    providerEpoch: 'startup-provider-epoch' as SshProviderEpoch
  }
}

function deployingRelayState(targetId: string): SshConnectionState {
  return {
    targetId,
    status: 'deploying-relay',
    error: null,
    reconnectAttempt: 0,
    providerEpoch: 'startup-provider-epoch' as SshProviderEpoch
  }
}

function controlledPromise<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

type Harness = {
  /** Mirrors the store slice: seeded wholesale, then cleared per target. */
  deferred: string[]
  published: [string, SshConnectionState][]
  starts: string[]
  args: SshStartupReconnectOrchestrationArgs
}

function createHarness(
  overrides: Partial<SshStartupReconnectOrchestrationArgs> & {
    connect: SshStartupReconnectOrchestrationArgs['connect']
    getState: SshStartupReconnectOrchestrationArgs['getState']
    targetIds: readonly string[]
  },
  concurrency = 3
): Harness {
  const harness = {
    deferred: [] as string[],
    published: [] as [string, SshConnectionState][],
    starts: [] as string[]
  }
  const args: SshStartupReconnectOrchestrationArgs = {
    criticalTargetIds: [],
    backgroundTargetIds: [],
    attemptTimeoutMs: 1_000,
    criticalBudgetMs: 1_000,
    signal: new AbortController().signal,
    publishState: (targetId, state) => harness.published.push([targetId, state]),
    setDeferredTargets: (targetIds) => {
      harness.deferred = [...targetIds]
    },
    removeDeferredTarget: (targetId) => {
      harness.deferred = harness.deferred.filter((id) => id !== targetId)
    },
    onFailure: () => {},
    runCriticalStep: (run) => run(),
    runBackgroundStep: (run) => run(),
    scheduler: new SshStartupReconnectScheduler(concurrency),
    ...overrides,
    connect: (targetId) => {
      harness.starts.push(targetId)
      return overrides.connect(targetId)
    }
  }
  // Same object the closures above mutate — a spread copy would freeze `deferred` at seed time.
  return Object.assign(harness, { args })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('startSshStartupReconnect', () => {
  it('returns after the critical batch while background hosts are still dialing', async () => {
    const background = controlledPromise<SshConnectionState>()
    const state = new Map<string, SshConnectionState>()
    const harness = createHarness({
      targetIds: ['ssh-active', 'ssh-bg', 'ssh-passphrase'],
      criticalTargetIds: ['ssh-active'],
      backgroundTargetIds: ['ssh-bg'],
      connect: (targetId) => {
        if (targetId === 'ssh-bg') {
          return background.promise
        }
        state.set(targetId, connectedState(targetId))
        return Promise.resolve(connectedState(targetId))
      },
      getState: (targetId) => Promise.resolve(state.get(targetId) ?? null)
    })

    const { criticalResults, backgroundSettled } = await startSshStartupReconnect(harness.args)

    expect(criticalResults).toEqual([{ targetId: 'ssh-active', outcome: 'completed' }])
    expect(harness.starts).toEqual(['ssh-active', 'ssh-bg'])
    // The gate is already open for the active host and still closed for everyone else.
    expect(harness.deferred).toEqual(['ssh-bg', 'ssh-passphrase'])

    state.set('ssh-bg', connectedState('ssh-bg'))
    background.resolve(connectedState('ssh-bg'))
    await expect(backgroundSettled).resolves.toEqual([{ targetId: 'ssh-bg', outcome: 'completed' }])
    // A passphrase target belongs to neither batch, so its gate survives until tab focus.
    expect(harness.deferred).toEqual(['ssh-passphrase'])
  })

  it('keeps a still-disconnected target gated after a failed attempt', async () => {
    const harness = createHarness({
      targetIds: ['ssh-down'],
      criticalTargetIds: ['ssh-down'],
      connect: () => Promise.reject(new Error('Authentication failed')),
      getState: (targetId) => Promise.resolve(disconnectedState(targetId))
    })

    const { criticalResults } = await startSshStartupReconnect(harness.args)

    expect(criticalResults).toEqual([{ targetId: 'ssh-down', outcome: 'failed' }])
    expect(harness.deferred).toEqual(['ssh-down'])
    expect(harness.published).toEqual([])
  })

  it('opens the gate for targets main finished after our own attempt gave up', async () => {
    vi.useFakeTimers()
    // Concurrency 1 + a 1s budget: only the first host is dialed, the rest expire queued. Main
    // still owns those connects, so a probe must release them instead of gating them forever.
    const harness = createHarness(
      {
        targetIds: ['ssh-hung', 'ssh-queued-up', 'ssh-queued-down'],
        criticalTargetIds: ['ssh-hung', 'ssh-queued-up', 'ssh-queued-down'],
        connect: () => new Promise<SshConnectionState>(() => {}),
        getState: (targetId) =>
          Promise.resolve(
            targetId === 'ssh-queued-down' ? disconnectedState(targetId) : connectedState(targetId)
          )
      },
      1
    )

    const started = startSshStartupReconnect(harness.args)
    await vi.advanceTimersByTimeAsync(1_000)
    const { criticalResults } = await started

    expect(criticalResults).toEqual([
      { targetId: 'ssh-hung', outcome: 'timed-out' },
      { targetId: 'ssh-queued-up', outcome: 'not-started-budget' },
      { targetId: 'ssh-queued-down', outcome: 'not-started-budget' }
    ])
    expect(harness.starts).toEqual(['ssh-hung'])
    expect(harness.deferred).toEqual(['ssh-queued-down'])
    expect(harness.published.map(([targetId]) => targetId).sort()).toEqual([
      'ssh-hung',
      'ssh-queued-up'
    ])
  })

  // Why: main holds a live connect at 'deploying-relay' until the relay session is ready, so a
  // half-up host reads as not-yet-connected here. Clearing the gate on it would remount SSH panes
  // before any PTY provider exists — the whole reason the gate is there.
  it('keeps a half-up target gated when the probe reports deploying-relay', async () => {
    vi.useFakeTimers()
    const harness = createHarness({
      targetIds: ['ssh-half-up'],
      criticalTargetIds: ['ssh-half-up'],
      connect: () => new Promise<SshConnectionState>(() => {}),
      getState: (targetId) => Promise.resolve(deployingRelayState(targetId))
    })

    const started = startSshStartupReconnect(harness.args)
    await vi.advanceTimersByTimeAsync(1_000)
    const { criticalResults } = await started

    expect(criticalResults).toEqual([{ targetId: 'ssh-half-up', outcome: 'timed-out' }])
    expect(harness.published).toEqual([])
    expect(harness.deferred).toEqual(['ssh-half-up'])
  })

  it('leaves the gate alone for a background batch cancelled by startup teardown', async () => {
    const abortController = new AbortController()
    const background = controlledPromise<SshConnectionState>()
    const getState = vi.fn(async (targetId: string) => connectedState(targetId))
    const harness = createHarness({
      targetIds: ['ssh-active', 'ssh-bg'],
      criticalTargetIds: ['ssh-active'],
      backgroundTargetIds: ['ssh-bg'],
      signal: abortController.signal,
      connect: (targetId) =>
        targetId === 'ssh-bg' ? background.promise : Promise.resolve(connectedState(targetId)),
      getState
    })

    const { backgroundSettled } = await startSshStartupReconnect(harness.args)
    getState.mockClear()
    abortController.abort()

    await expect(backgroundSettled).resolves.toEqual([{ targetId: 'ssh-bg', outcome: 'cancelled' }])
    expect(getState).not.toHaveBeenCalled()
    expect(harness.deferred).toEqual(['ssh-bg'])
    background.resolve(connectedState('ssh-bg'))
  })

  it('skips the background batch entirely when there is nothing left to dial', async () => {
    const harness = createHarness({
      targetIds: ['ssh-active'],
      criticalTargetIds: ['ssh-active'],
      backgroundTargetIds: [],
      connect: (targetId) => Promise.resolve(connectedState(targetId)),
      getState: (targetId) => Promise.resolve(connectedState(targetId))
    })
    const runBackgroundStep = vi.fn<SshStartupReconnectOrchestrationArgs['runBackgroundStep']>(
      (run) => run()
    )

    const { backgroundSettled } = await startSshStartupReconnect({
      ...harness.args,
      runBackgroundStep
    })

    expect(backgroundSettled).toBeNull()
    expect(runBackgroundStep).not.toHaveBeenCalled()
    expect(harness.deferred).toEqual([])
  })

  it('reports both batches to the startup timer under their own step names', async () => {
    const steps: string[] = []
    const harness = createHarness({
      targetIds: ['ssh-active', 'ssh-bg'],
      criticalTargetIds: ['ssh-active'],
      backgroundTargetIds: ['ssh-bg'],
      connect: (targetId) => Promise.resolve(connectedState(targetId)),
      getState: (targetId) => Promise.resolve(connectedState(targetId))
    })
    const track =
      (name: string) =>
      (
        run: () => Promise<SshStartupReconnectBatchResult[]>
      ): Promise<SshStartupReconnectBatchResult[]> => {
        steps.push(name)
        return run()
      }

    const { backgroundSettled } = await startSshStartupReconnect({
      ...harness.args,
      runCriticalStep: track('ssh-reconnect'),
      runBackgroundStep: track('ssh-reconnect-background')
    })
    await backgroundSettled

    expect(steps).toEqual(['ssh-reconnect', 'ssh-reconnect-background'])
    expect(harness.deferred).toEqual([])
  })
})
