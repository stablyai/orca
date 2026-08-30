import { describe, expect, it, vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import { useAgentCompletionCoordinatorLifecycle } from './agent-completion-coordinator-test-harness'
import { POLL_TIER_INTERVAL_MS } from './agent-completion-poll-cadence'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'

// Pins the mirror of the positive-exited arm.
//
// The exit gate used to read `if (result.hasChildProcesses)` and refuse on
// `true`. Moving to the evidence union dropped the legacy field entirely, so
// the gate now refuses only on a children verdict other than 'exited'. That is
// more conservative in one direction (a lossy legacy `false` beside a
// positively observed 'live' no longer completes) and LESS conservative in the
// other: `hasChildProcesses: true` beside `children: 'exited'` is a shape the
// old line refused and the verdict-only gate waves through.
//
// The `false` pole of the boolean is the lossy collapse this batch exists to
// remove — it conflates "no children" with "could not ask". The `true` pole is
// not lossy: every producer sets it from a positive observation
// (buildPtyProcessInspectionWireResult from `children.verdict === 'live'`,
// processHasChildren from a pgrep that exited 0 with output, the daemon host
// from an observed non-shell foreground). Discarding a positive liveness
// observation to honour a disagreeing 'exited' is the polarity bug pointing the
// other way, so the gate must refuse whenever either half says children are
// live. No mock is needed: readPtyProcessInspectionEvidence never cross-checks
// the legacy scalar against the union, so this shape flows through the real
// reader exactly as its mirror does.
function exitedChildrenWithLegacyTrue(
  foregroundProcess: string | null
): RuntimeTerminalProcessInspection {
  return {
    foregroundProcess,
    // The legacy field positively reports live children; the union disagrees.
    hasChildProcesses: true,
    processEvidence: {
      foreground: { verdict: 'observed', processName: foregroundProcess },
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

describe('agent completion refuses an exited verdict the legacy field contradicts', () => {
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

  it('never completes while the legacy field reports live children, even when the verdict says exited', async () => {
    let result = conforming('codex', 'live')
    const { dispatchCompletion } = startCoordinator(() => result)

    await vi.advanceTimersByTimeAsync(2_000)

    // Foreground is observed and the children verdict is inside the vocabulary
    // and positively 'exited', so neither the vocabulary guard nor the
    // positive-exited arm can refuse this sample. The only half of the
    // inspection that still reports live children is the legacy boolean.
    result = exitedChildrenWithLegacyTrue('zsh')
    await vi.advanceTimersByTimeAsync(60_000)

    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it('still completes once the same host publishes a coherent exited pair', async () => {
    let result = conforming('codex', 'live')
    const { dispatchCompletion } = startCoordinator(() => result)

    await vi.advanceTimersByTimeAsync(2_000)

    result = exitedChildrenWithLegacyTrue('zsh')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(dispatchCompletion).not.toHaveBeenCalled()

    // Refusing the contradicting sample must not wedge the monitor.
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
    // The sample read fine — both halves parsed, they just disagree — so it
    // must refuse without charging an inspection error. Charging one would
    // slide a long-running agent down the error backoff (2x the active tier on
    // the first error) for free. Jitter is pinned to 1.0 by the shared
    // lifecycle.
    const activeTier = POLL_TIER_INTERVAL_MS.active
    let result = conforming('codex', 'live')
    const { dispatchCompletion, pollTimes } = startCoordinator(() => result)

    await vi.advanceTimersByTimeAsync(4_000)
    expect(pollTimes.length).toBeGreaterThan(2)
    expect(pollTimes[2] - pollTimes[1]).toBe(activeTier)

    const switchedAt = Date.now()
    result = exitedChildrenWithLegacyTrue('zsh')
    await vi.advanceTimersByTimeAsync(10_000)

    expect(dispatchCompletion).not.toHaveBeenCalled()
    const firstContradiction = pollTimes.findIndex((time) => time > switchedAt)
    expect(firstContradiction).toBeGreaterThan(-1)
    expect(pollTimes.length).toBeGreaterThan(firstContradiction + 1)
    expect(pollTimes[firstContradiction + 1] - pollTimes[firstContradiction]).toBe(activeTier)
  })
})
