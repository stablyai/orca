import { describe, expect, it, vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import { useAgentCompletionCoordinatorLifecycle } from './agent-completion-coordinator-test-harness'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'

// Pins the positive-exited arm on its own, independently of the
// out-of-vocabulary guard.
//
// Given the vocabulary guard, every sample that reaches the exit gate already
// carries a children verdict of 'live' or 'exited'. Against a host that builds
// its wire result with buildPtyProcessInspectionWireResult the legacy
// `hasChildProcesses` boolean is exactly `children.verdict === 'live'`, so on
// that host reading the boolean and requiring a positive 'exited' agree — the
// arm is invisible.
//
// They part company on the one shape the reader is explicitly written to
// survive: a peer this client cannot vouch for, whose two fields disagree.
// `readPtyProcessInspectionEvidence` never cross-checks the legacy scalar
// against the evidence union, so `hasChildProcesses: false` can arrive beside a
// positively observed `children: 'live'`. The boolean's `false` is the lossy
// collapse that conflates "no children" with "could not tell" — the polarity
// bug from #16900/#16908. The evidence union is the authoritative vocabulary,
// so `live` must refuse completion even though the legacy field would wave it
// through. No mock is needed: this shape flows through the real reader.
function liveChildrenWithLegacyFalse(
  foregroundProcess: string | null
): RuntimeTerminalProcessInspection {
  return {
    foregroundProcess,
    // The lossy legacy collapse disagrees with the authoritative evidence.
    hasChildProcesses: false,
    processEvidence: {
      foreground: { verdict: 'observed', processName: foregroundProcess },
      children: { verdict: 'live' }
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

describe('agent completion requires a positively matched exited verdict', () => {
  useAgentCompletionCoordinatorLifecycle()

  function startCoordinator(results: () => RuntimeTerminalProcessInspection) {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(async () => results()),
      dispatchCompletion,
      isLive: () => true
    })
    coordinator.startProcessTracking()
    return { coordinator, dispatchCompletion }
  }

  it('never completes while children are positively live, even when the legacy field says otherwise', async () => {
    let result = conforming('codex', 'live')
    const { dispatchCompletion } = startCoordinator(() => result)

    await vi.advanceTimersByTimeAsync(2_000)

    // Foreground is observed and inside the vocabulary, and so is the children
    // verdict — the vocabulary guard has nothing to refuse here. The only arm
    // that can still refuse is the one that demands a positive 'exited', and
    // it must, because the host positively observed live children.
    result = liveChildrenWithLegacyFalse('zsh')
    await vi.advanceTimersByTimeAsync(60_000)

    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it('still completes once the same host positively reports exited', async () => {
    let result = conforming('codex', 'live')
    const { dispatchCompletion } = startCoordinator(() => result)

    await vi.advanceTimersByTimeAsync(2_000)

    result = liveChildrenWithLegacyFalse('zsh')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(dispatchCompletion).not.toHaveBeenCalled()

    // Refusing the disagreeing sample must not wedge the monitor.
    result = conforming('zsh', 'exited')
    await vi.advanceTimersByTimeAsync(30_000)

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith('codex', {
      source: 'process-exit',
      quietedHookDone: false,
      terminalIdleConfirmed: true
    })
  })

  it('treats a positively live sample as a readable inspection, not a failed one', async () => {
    // The vocabulary guard re-arms with an inspection-error backoff because the
    // sample could not be read. A 'live' sample was read fine — it just is not
    // an exit — so the exit arm must refuse without charging an error, or a
    // long-running agent would slide down the error backoff for free.
    let result = conforming('codex', 'live')
    const { dispatchCompletion } = startCoordinator(() => result)

    await vi.advanceTimersByTimeAsync(2_000)

    result = liveChildrenWithLegacyFalse('zsh')
    await vi.advanceTimersByTimeAsync(20_000)

    // A single conforming exit sample confirms against the pending exit that
    // the live samples left standing; had they been charged as errors, the
    // pending exit would have been cleared and re-armed instead.
    result = conforming('zsh', 'exited')
    await vi.advanceTimersByTimeAsync(30_000)

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
  })
})
