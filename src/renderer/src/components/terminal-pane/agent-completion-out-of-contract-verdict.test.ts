import { describe, expect, it, vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import { useAgentCompletionCoordinatorLifecycle } from './agent-completion-coordinator-test-harness'
import { POLL_TIER_INTERVAL_MS } from './agent-completion-poll-cadence'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'
import type * as PtyProcessInspectionEvidenceModule from '../../../../shared/pty-process-inspection-evidence'

// Models the forward-compatibility hazard directly: a newer host publishes a
// verdict outside this build's vocabulary and a future evidence funnel admits
// it verbatim instead of coercing it to 'unverifiable'. Today's reader coerces,
// so the monitor's out-of-vocabulary guard is only reachable through this mock
// — that guard exists precisely so the coercion is not the only thing standing
// between a new host arm and a false completion.
vi.mock('../../../../shared/pty-process-inspection-evidence', async (importOriginal) => {
  const real = await importOriginal<typeof PtyProcessInspectionEvidenceModule>()
  return {
    ...real,
    readPtyProcessInspectionEvidence: (
      result: Parameters<typeof real.readPtyProcessInspectionEvidence>[0]
    ) => {
      const evidence = result.processEvidence
      const childrenVerdict = evidence?.children.verdict as string | undefined
      const foregroundVerdict = evidence?.foreground.verdict as string | undefined
      if (evidence && (childrenVerdict === 'reparented' || foregroundVerdict === 'inferred')) {
        return evidence
      }
      return real.readPtyProcessInspectionEvidence(result)
    }
  }
})

function evidenceResult(
  foregroundProcess: string | null,
  childrenVerdict: string
): RuntimeTerminalProcessInspection {
  return {
    foregroundProcess,
    hasChildProcesses: childrenVerdict === 'live',
    processEvidence: {
      foreground: { verdict: 'observed', processName: foregroundProcess },
      children: { verdict: childrenVerdict } as never
    }
  }
}

// A foreground arm this build has no case for, paired with a children probe
// that positively reports 'exited'. The children gate reads a legitimate exit
// here, so only the foreground half of the vocabulary guard can refuse it.
function outOfContractForeground(): RuntimeTerminalProcessInspection {
  return {
    foregroundProcess: 'zsh',
    hasChildProcesses: false,
    processEvidence: {
      foreground: { verdict: 'inferred', processName: 'zsh' } as never,
      children: { verdict: 'exited' }
    }
  }
}

describe('agent completion with an out-of-contract children verdict', () => {
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

  it('never dispatches completion from a verdict outside the exited contract', async () => {
    let result = evidenceResult('codex', 'live')
    const { dispatchCompletion } = startCoordinator(() => result)

    await vi.advanceTimersByTimeAsync(2_000)

    // The host now answers with a verdict this build has no arm for.
    result = evidenceResult('zsh', 'reparented')
    await vi.advanceTimersByTimeAsync(60_000)

    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it('still completes once the host positively reports exited', async () => {
    let result = evidenceResult('codex', 'live')
    const { dispatchCompletion } = startCoordinator(() => result)

    await vi.advanceTimersByTimeAsync(2_000)

    result = evidenceResult('zsh', 'reparented')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(dispatchCompletion).not.toHaveBeenCalled()

    // The unknown arm must not have wedged the monitor: a positively matched
    // exit observed afterwards still completes.
    result = evidenceResult('zsh', 'exited')
    await vi.advanceTimersByTimeAsync(30_000)

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith('codex', {
      source: 'process-exit',
      quietedHookDone: false,
      terminalIdleConfirmed: true
    })
  })

  it('never dispatches completion from a foreground verdict outside the observed contract', async () => {
    let result = evidenceResult('codex', 'live')
    const { dispatchCompletion } = startCoordinator(() => result)

    await vi.advanceTimersByTimeAsync(2_000)

    // Children positively report 'exited' — the exit gate is satisfied. The
    // only thing that knows this sample is worthless is the foreground arm:
    // the host never said it observed the foreground process.
    result = outOfContractForeground()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it('completes once the foreground verdict returns to observed', async () => {
    let result = evidenceResult('codex', 'live')
    const { dispatchCompletion } = startCoordinator(() => result)

    await vi.advanceTimersByTimeAsync(2_000)

    result = outOfContractForeground()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(dispatchCompletion).not.toHaveBeenCalled()

    // Refusing the unknown foreground arm must not wedge the monitor either.
    result = evidenceResult('zsh', 'exited')
    await vi.advanceTimersByTimeAsync(30_000)

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith('codex', {
      source: 'process-exit',
      quietedHookDone: false,
      terminalIdleConfirmed: true
    })
  })

  it('counts an out-of-contract children verdict as a failed inspection', async () => {
    // Refusing to complete is not enough: the guard promises to "re-arm the
    // two-sample confirmation like any other failed inspection". A sample the
    // client cannot read is a failed read, so the next poll must take the
    // inspection-error backoff (2x the active tier on the first error), not the
    // clean-sample cadence. Jitter is pinned to 1.0 by the shared lifecycle.
    const activeTier = POLL_TIER_INTERVAL_MS.active
    let result = evidenceResult('codex', 'live')
    const { pollTimes } = startCoordinator(() => result)

    await vi.advanceTimersByTimeAsync(4_000)

    // Baseline: clean samples poll at the active cadence.
    expect(pollTimes.length).toBeGreaterThan(2)
    expect(pollTimes[2] - pollTimes[1]).toBe(activeTier)

    const switchedAt = Date.now()
    result = evidenceResult('zsh', 'reparented')
    await vi.advanceTimersByTimeAsync(10_000)

    const firstUnknown = pollTimes.findIndex((time) => time > switchedAt)
    expect(firstUnknown).toBeGreaterThan(-1)
    expect(pollTimes.length).toBeGreaterThan(firstUnknown + 1)
    expect(pollTimes[firstUnknown + 1] - pollTimes[firstUnknown]).toBe(activeTier * 2)
  })
})
