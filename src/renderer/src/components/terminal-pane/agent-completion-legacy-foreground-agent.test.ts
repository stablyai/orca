import { describe, expect, it, vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import { useAgentCompletionCoordinatorLifecycle } from './agent-completion-coordinator-test-harness'
import { POLL_TIER_INTERVAL_MS } from './agent-completion-poll-cadence'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'

// Pins the foreground axis of the legacy-contradiction rule, one axis over from
// agent-completion-legacy-live-children.test.ts.
//
// Recognition used to read `recognizeAgentProcess(result.foregroundProcess)`.
// Moving it onto the evidence union made it read
// `evidence.foreground.processName` and dropped the legacy field, so a sample
// whose union reports `{observed, processName: null}` beside a legacy
// `foregroundProcess: 'codex'` no longer recognizes an agent. The union's
// foreground verdict is still inside the vocabulary, so the out-of-vocabulary
// guard cannot refuse it either, and the sample falls straight through to the
// exit gate and completes the agent that is still in the foreground.
//
// Only the `null` pole of the legacy scalar is the lossy collapse this batch
// removes; it conflates "no agent in the foreground" with "could not ask". A
// recognized non-null name is a positive observation on every producer:
// buildPtyProcessInspectionWireResult copies it straight off an `observed`
// foreground verdict, and the ps/pgrep probes only set it from a command line
// the host actually read back. Discarding a positive liveness observation to
// honour a union that reports no name is the #16900/#16908 polarity bug
// mirrored onto the foreground axis, so the exit gate must refuse whenever
// either half still names a recognized agent.
//
// No mock is needed: readPtyProcessInspectionEvidence never cross-checks the
// legacy scalar against the union, so this shape flows through the real reader
// exactly as its children-axis mirror does.
function unnamedForegroundWithLegacyAgent(
  legacyForegroundProcess: string
): RuntimeTerminalProcessInspection {
  return {
    // The legacy field positively names a recognized agent; the union does not.
    foregroundProcess: legacyForegroundProcess,
    hasChildProcesses: false,
    processEvidence: {
      foreground: { verdict: 'observed', processName: null },
      children: { verdict: 'exited' }
    }
  }
}

function conforming(
  foregroundProcess: string | null,
  childrenVerdict: 'live' | 'exited'
): RuntimeTerminalProcessInspection {
  return {
    foregroundProcess,
    hasChildProcesses: childrenVerdict === 'live',
    processEvidence: {
      foreground: { verdict: 'observed', processName: foregroundProcess },
      children: { verdict: childrenVerdict }
    }
  }
}

describe('agent completion refuses an exit the legacy foreground field contradicts', () => {
  useAgentCompletionCoordinatorLifecycle()

  function startCoordinator(results: () => RuntimeTerminalProcessInspection) {
    const dispatchCompletion = vi.fn()
    const pollTimes: number[] = []
    const inspectProcess = vi.fn(async () => {
      pollTimes.push(Date.now())
      return results()
    })
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess,
      dispatchCompletion,
      isLive: () => true
    })
    coordinator.startProcessTracking()
    return { coordinator, dispatchCompletion, pollTimes }
  }

  it('never completes while the legacy field still names the running agent', async () => {
    let result = conforming('codex', 'live')
    const { dispatchCompletion } = startCoordinator(() => result)

    await vi.advanceTimersByTimeAsync(2_000)

    // The union's foreground verdict is 'observed' and its children verdict is
    // positively 'exited', so neither the out-of-vocabulary guard nor the
    // positive-exited arm can refuse this sample, and the legacy children
    // boolean agrees with 'exited'. The only half of the inspection that still
    // reports the agent is the legacy foreground scalar.
    result = unnamedForegroundWithLegacyAgent('codex')
    await vi.advanceTimersByTimeAsync(60_000)

    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it('refuses on a legacy agent name that differs from the one it is completing', async () => {
    let result = conforming('codex', 'live')
    const { dispatchCompletion } = startCoordinator(() => result)

    await vi.advanceTimersByTimeAsync(2_000)

    // A recognized agent in the foreground contradicts "the agent exited"
    // whichever agent it is; the client cannot tell which half of a
    // disagreeing peer's report is the stale one.
    result = unnamedForegroundWithLegacyAgent('claude')
    await vi.advanceTimersByTimeAsync(60_000)

    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it('still completes once the same host publishes a coherent unnamed foreground', async () => {
    let result = conforming('codex', 'live')
    const { dispatchCompletion } = startCoordinator(() => result)

    await vi.advanceTimersByTimeAsync(2_000)

    result = unnamedForegroundWithLegacyAgent('codex')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(dispatchCompletion).not.toHaveBeenCalled()

    // Refusing the contradicting sample must not wedge the monitor. An
    // unrecognized legacy name is the normal post-exit shell, not a positive
    // agent observation, so it must still complete.
    result = conforming('zsh', 'exited')
    await vi.advanceTimersByTimeAsync(30_000)

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith('codex', {
      source: 'process-exit',
      quietedHookDone: false,
      terminalIdleConfirmed: true
    })
  })

  it('treats the contradicting sample as a readable inspection, not a failed one', async () => {
    // Both halves parsed — they only disagree — so refusing must not charge an
    // inspection error. Charging one would slide a long-running agent down the
    // error backoff (2x the active tier on the first error) for free. Jitter is
    // pinned to 1.0 by the shared lifecycle.
    const activeTier = POLL_TIER_INTERVAL_MS.active
    let result = conforming('codex', 'live')
    const { dispatchCompletion, pollTimes } = startCoordinator(() => result)

    await vi.advanceTimersByTimeAsync(4_000)
    expect(pollTimes.length).toBeGreaterThan(2)
    expect(pollTimes[2] - pollTimes[1]).toBe(activeTier)

    const switchedAt = Date.now()
    result = unnamedForegroundWithLegacyAgent('codex')
    await vi.advanceTimersByTimeAsync(10_000)

    expect(dispatchCompletion).not.toHaveBeenCalled()
    const firstContradiction = pollTimes.findIndex((time) => time > switchedAt)
    expect(firstContradiction).toBeGreaterThan(-1)
    expect(pollTimes.length).toBeGreaterThan(firstContradiction + 1)
    expect(pollTimes[firstContradiction + 1] - pollTimes[firstContradiction]).toBe(activeTier)
  })
})
