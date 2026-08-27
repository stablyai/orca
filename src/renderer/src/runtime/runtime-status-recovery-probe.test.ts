import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeStatusRefreshOutcome } from '@/store/slices/runtime-status-refresh'
import {
  noteRuntimeEnvironmentReachable,
  retryRuntimeStatusRecoveryProbesNow,
  startRuntimeStatusRecoveryProbe,
  type RuntimeStatusRecoveryPort
} from './runtime-status-recovery-probe'

/**
 * Mirrors the two facts the real port bridges: what the shared host derivation currently reads
 * for an environment, and what a fresh `status.get` would answer. Only the probe's answer moves
 * the record — and a reachable answer does not always clear the verdict, because a control
 * channel that closed with an error derives as `disconnected` on a truthy status.
 */
type HostAnswer = { outcome: RuntimeStatusRefreshOutcome; disconnectedAfter: boolean }

function createPort(): {
  port: RuntimeStatusRecoveryPort
  refresh: ReturnType<typeof vi.fn>
  markDisconnected: (environmentId: string) => void
  letHostAnswer: (environmentId: string) => void
  letHostAnswerWhileDisconnected: (environmentId: string) => void
  letProbeBeSuperseded: (environmentId: string) => void
} {
  const disconnectedHosts = new Set<string>()
  const hostAnswers = new Map<string, HostAnswer>()
  const statusChangeListeners = new Set<() => void>()
  const notifyStatusChanged = (): void => statusChangeListeners.forEach((listener) => listener())
  const refresh = vi.fn(async (environmentId: string): Promise<RuntimeStatusRefreshOutcome> => {
    const answer: HostAnswer = hostAnswers.get(environmentId) ?? {
      outcome: 'unreachable',
      disconnectedAfter: true
    }
    // A superseded answer publishes nothing, so the recorded verdict cannot move.
    if (answer.outcome !== 'superseded') {
      if (answer.disconnectedAfter) {
        disconnectedHosts.add(environmentId)
      } else {
        disconnectedHosts.delete(environmentId)
      }
    }
    return answer.outcome
  })
  const answerWith =
    (outcome: RuntimeStatusRefreshOutcome, disconnectedAfter: boolean) =>
    (environmentId: string): void => {
      hostAnswers.set(environmentId, { outcome, disconnectedAfter })
    }
  return {
    port: {
      isRuntimeEnvironmentDisconnected: (environmentId) => disconnectedHosts.has(environmentId),
      listDisconnectedRuntimeEnvironmentIds: () => [...disconnectedHosts],
      refreshRuntimeEnvironmentStatus: refresh,
      subscribeToRecordedStatusChanges: (onChange) => {
        statusChangeListeners.add(onChange)
        return () => statusChangeListeners.delete(onChange)
      }
    },
    refresh,
    markDisconnected: (environmentId) => {
      disconnectedHosts.add(environmentId)
      notifyStatusChanged()
    },
    letHostAnswer: answerWith('reachable', false),
    letHostAnswerWhileDisconnected: answerWith('reachable', true),
    letProbeBeSuperseded: answerWith('superseded', true)
  }
}

describe('runtime status recovery probe', () => {
  let stop: (() => void) | null = null

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    stop?.()
    stop = null
    vi.useRealTimers()
  })

  it('re-probes an unreachable host as soon as it answers a request', async () => {
    // The reported failure: one failed boot probe pinned a live host to a red
    // "disconnected" glyph for the whole session while its mirroring, agents and
    // terminals kept working over the same transport (#16516).
    const { port, refresh, markDisconnected, letHostAnswer } = createPort()
    markDisconnected('honey-mac')
    letHostAnswer('honey-mac')
    stop = startRuntimeStatusRecoveryProbe(port)

    noteRuntimeEnvironmentReachable('honey-mac')
    await vi.advanceTimersByTimeAsync(0)

    expect(refresh).toHaveBeenCalledWith('honey-mac')
    expect(port.isRuntimeEnvironmentDisconnected('honey-mac')).toBe(false)
  })

  it('ignores traffic to a host whose status is already known', () => {
    // Why: mirroring alone answers many requests a second. Only an entry stuck on
    // `null` is worth a probe; everything else must stay free.
    const { port, refresh } = createPort()
    stop = startRuntimeStatusRecoveryProbe(port)

    noteRuntimeEnvironmentReachable('honey-mac')

    expect(refresh).not.toHaveBeenCalled()
  })

  it('never reports a host reachable on traffic alone', async () => {
    // Why: docs/reference/ssh-execution-boundary.md — the probe's answer is the only
    // verdict. A host that answered one request but fails status.get stays unreachable.
    const { port, refresh, markDisconnected } = createPort()
    markDisconnected('honey-mac')
    stop = startRuntimeStatusRecoveryProbe(port)

    noteRuntimeEnvironmentReachable('honey-mac')
    await vi.advanceTimersByTimeAsync(0)

    expect(refresh).toHaveBeenCalledTimes(1)
    await expect(refresh.mock.results[0].value).resolves.toBe('unreachable')
  })

  it('coalesces a burst of traffic into one in-flight probe', async () => {
    const { port, refresh, markDisconnected } = createPort()
    markDisconnected('honey-mac')
    stop = startRuntimeStatusRecoveryProbe(port)

    noteRuntimeEnvironmentReachable('honey-mac')
    noteRuntimeEnvironmentReachable('honey-mac')
    noteRuntimeEnvironmentReachable('honey-mac')

    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('does not turn RPC frequency into probe frequency after a failed probe', async () => {
    // A host that answers requests but fails `status.get` used to get one probe per
    // request: every note dropped the backoff entry and re-probed.
    const { port, refresh, markDisconnected } = createPort()
    markDisconnected('honey-mac')
    stop = startRuntimeStatusRecoveryProbe(port)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(refresh).toHaveBeenCalledTimes(1)

    for (let index = 0; index < 20; index += 1) {
      noteRuntimeEnvironmentReachable('honey-mac')
      await vi.advanceTimersByTimeAsync(0)
    }

    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('recovers a host sitting at the backoff cap as soon as it answers a request', async () => {
    // Why traffic is not gated on `nextAttemptAt`: at the 60s cap that would hold the red
    // glyph for up to another minute on a host the user is actively working with (#16516).
    const { port, refresh, markDisconnected, letHostAnswer } = createPort()
    markDisconnected('honey-mac')
    stop = startRuntimeStatusRecoveryProbe(port)

    await vi.advanceTimersByTimeAsync(600_000)
    const callsBeforeTraffic = refresh.mock.calls.length

    letHostAnswer('honey-mac')
    noteRuntimeEnvironmentReachable('honey-mac')
    await vi.advanceTimersByTimeAsync(0)

    expect(refresh).toHaveBeenCalledTimes(callsBeforeTraffic + 1)
    expect(port.isRuntimeEnvironmentDisconnected('honey-mac')).toBe(false)
  })

  it('lets traffic probe again once the floor between traffic probes has elapsed', async () => {
    // The throttle is a floor of its own, not a deferral to the failure backoff, so
    // recovery stays within one base interval however long the outage has been running.
    const { port, refresh, markDisconnected } = createPort()
    markDisconnected('honey-mac')
    stop = startRuntimeStatusRecoveryProbe(port)

    noteRuntimeEnvironmentReachable('honey-mac')
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(4_000)
    noteRuntimeEnvironmentReachable('honey-mac')
    expect(refresh).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1_000)
    noteRuntimeEnvironmentReachable('honey-mac')
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('keeps re-probing an unreachable host on a widening backoff', async () => {
    const { port, refresh, markDisconnected } = createPort()
    markDisconnected('honey-mac')
    stop = startRuntimeStatusRecoveryProbe(port)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(refresh).toHaveBeenCalledTimes(1)

    // Still unreachable, so the next attempt waits twice as long.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('stops probing once a host answers and stays idle afterwards', async () => {
    const { port, refresh, markDisconnected, letHostAnswer } = createPort()
    markDisconnected('honey-mac')
    letHostAnswer('honey-mac')
    stop = startRuntimeStatusRecoveryProbe(port)

    await vi.advanceTimersByTimeAsync(5_000)
    const callsAfterRecovery = refresh.mock.calls.length

    await vi.advanceTimersByTimeAsync(300_000)

    expect(refresh).toHaveBeenCalledTimes(callsAfterRecovery)
  })

  it('probes every unreachable host, not just the first', async () => {
    const { port, refresh, markDisconnected } = createPort()
    markDisconnected('honey-mac')
    markDisconnected('openclaw')
    stop = startRuntimeStatusRecoveryProbe(port)

    await vi.advanceTimersByTimeAsync(5_000)

    expect(refresh.mock.calls.map(([id]) => id).sort()).toEqual(['honey-mac', 'openclaw'])
  })

  it('starts the clock for a host that goes unreachable after the app is running', async () => {
    // The real ordering: the probe starts with the app shell, before boot hydration
    // has recorded anything. An empty map at start must not leave it idle for good.
    const { port, refresh, markDisconnected } = createPort()
    stop = startRuntimeStatusRecoveryProbe(port)

    markDisconnected('honey-mac')
    await vi.advanceTimersByTimeAsync(5_000)

    expect(refresh).toHaveBeenCalledWith('honey-mac')
  })

  it('backs each host off on its own clock', async () => {
    // Why: a shared deadline let a host that just started failing drag a
    // long-unreachable one back to the base interval on every sweep.
    const { port, refresh, markDisconnected } = createPort()
    markDisconnected('honey-mac')
    stop = startRuntimeStatusRecoveryProbe(port)

    // honey-mac fails twice, so its next attempt is a full 20s out.
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(refresh.mock.calls.filter(([id]) => id === 'honey-mac')).toHaveLength(2)

    markDisconnected('openclaw')
    await vi.advanceTimersByTimeAsync(5_000)

    expect(refresh.mock.calls.filter(([id]) => id === 'openclaw')).toHaveLength(1)
    expect(refresh.mock.calls.filter(([id]) => id === 'honey-mac')).toHaveLength(2)
  })

  it('collapses the backoff when the machine comes back online', async () => {
    const { port, refresh, markDisconnected } = createPort()
    markDisconnected('honey-mac')
    stop = startRuntimeStatusRecoveryProbe(port)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(refresh).toHaveBeenCalledTimes(1)

    retryRuntimeStatusRecoveryProbesNow()
    await vi.advanceTimersByTimeAsync(0)

    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('keeps probing other hosts while one probe never settles', async () => {
    // Why: the sweep is the recovery mechanism of last resort. A refresh that never
    // settles — a wedged IPC round trip — must not take every other host's retry
    // down with it, which is exactly what deferring the re-arm to the probe did.
    const { port, refresh, markDisconnected } = createPort()
    markDisconnected('wedged-host')
    markDisconnected('honey-mac')
    refresh.mockImplementation((environmentId: string) =>
      environmentId === 'wedged-host'
        ? new Promise<RuntimeStatusRefreshOutcome>(() => {})
        : Promise.resolve('unreachable')
    )
    stop = startRuntimeStatusRecoveryProbe(port)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(refresh.mock.calls.filter(([id]) => id === 'honey-mac')).toHaveLength(1)

    // honey-mac failed, so it is due again 10s later regardless of the wedged host.
    await vi.advanceTimersByTimeAsync(10_000)

    expect(refresh.mock.calls.filter(([id]) => id === 'honey-mac')).toHaveLength(2)

    // The wedged host is re-checked on the pending guard rather than re-probed, and the
    // guard keeps that from degenerating into a zero-delay timer loop.
    await vi.advanceTimersByTimeAsync(300_000)
    expect(refresh.mock.calls.filter(([id]) => id === 'wedged-host')).toHaveLength(1)
  })

  it('keeps widening the backoff for a host that answers but still reads disconnected', async () => {
    // Why: `remoteControl.state === 'closed'` with a `lastError` derives as disconnected on a
    // truthy status, so `status.get` succeeding is not recovery. Trusting the RPC's own verdict
    // would clear the budget on every probe and turn this loop into a 5s poll forever.
    const { port, refresh, markDisconnected, letHostAnswerWhileDisconnected } = createPort()
    markDisconnected('honey-mac')
    letHostAnswerWhileDisconnected('honey-mac')
    stop = startRuntimeStatusRecoveryProbe(port)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(refresh).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('does not count a superseded probe against the host', async () => {
    // Why: a same-id re-pair retires the answer in flight. It says nothing about the new
    // pairing's reachability, so charging it a failure makes the fresh host wait 10s, not 5s.
    const { port, refresh, markDisconnected, letProbeBeSuperseded } = createPort()
    markDisconnected('honey-mac')
    letProbeBeSuperseded('honey-mac')
    stop = startRuntimeStatusRecoveryProbe(port)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(refresh).toHaveBeenCalledTimes(1)

    // Still the base interval: a failure would have pushed the next attempt out to 10s.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('probes nothing after it is stopped', async () => {
    const { port, refresh, markDisconnected } = createPort()
    markDisconnected('honey-mac')
    startRuntimeStatusRecoveryProbe(port)()

    noteRuntimeEnvironmentReachable('honey-mac')
    retryRuntimeStatusRecoveryProbesNow()
    await vi.advanceTimersByTimeAsync(300_000)

    expect(refresh).not.toHaveBeenCalled()
  })

  it('ignores a probe that settles after its session was stopped', async () => {
    // React StrictMode double-mounts the effect that installs the port, so a probe from the
    // retired mount routinely settles into the live one. Letting it clear the live in-flight
    // marker lets the next sweep open a second probe for a host already being probed.
    const { port, refresh, markDisconnected } = createPort()
    markDisconnected('honey-mac')
    const settleProbe: ((outcome: RuntimeStatusRefreshOutcome) => void)[] = []
    refresh.mockImplementation(
      () => new Promise<RuntimeStatusRefreshOutcome>((resolve) => settleProbe.push(resolve))
    )
    const stopRetiredSession = startRuntimeStatusRecoveryProbe(port)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(settleProbe).toHaveLength(1)

    stopRetiredSession()
    stop = startRuntimeStatusRecoveryProbe(port)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(settleProbe).toHaveLength(2)

    settleProbe[0]('unreachable')
    await vi.advanceTimersByTimeAsync(60_000)

    // The live probe is still in flight, so nothing may open a second one for the same host.
    expect(settleProbe).toHaveLength(2)
  })

  it('does not charge a retired probe against the live retry budget', async () => {
    // The retired answer describes a pairing that no longer exists, so widening the fresh
    // session's backoff with it pushes its first real attempt past its own base interval.
    const { port, refresh, markDisconnected } = createPort()
    markDisconnected('honey-mac')
    const settleProbe: ((outcome: RuntimeStatusRefreshOutcome) => void)[] = []
    refresh.mockImplementation(
      () => new Promise<RuntimeStatusRefreshOutcome>((resolve) => settleProbe.push(resolve))
    )
    const stopRetiredSession = startRuntimeStatusRecoveryProbe(port)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(settleProbe).toHaveLength(1)

    stopRetiredSession()
    stop = startRuntimeStatusRecoveryProbe(port)

    // The retired probe settles before the fresh session's first attempt is due.
    settleProbe[0]('unreachable')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(5_000)

    expect(settleProbe).toHaveLength(2)
  })

  it('survives a probe that rejects', async () => {
    const { port, markDisconnected } = createPort()
    markDisconnected('honey-mac')
    const rejecting = {
      ...port,
      refreshRuntimeEnvironmentStatus: vi.fn(() => Promise.reject(new Error('transport closed')))
    }
    stop = startRuntimeStatusRecoveryProbe(rejecting)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(rejecting.refreshRuntimeEnvironmentStatus).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(rejecting.refreshRuntimeEnvironmentStatus).toHaveBeenCalledTimes(2)
  })
})
