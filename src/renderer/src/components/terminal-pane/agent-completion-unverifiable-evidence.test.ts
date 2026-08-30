import { describe, expect, it, vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import {
  processResult,
  useAgentCompletionCoordinatorLifecycle
} from './agent-completion-coordinator-test-harness'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'
import type { PtyApi } from '../../../../preload/api/pty-api'

// The renderer-visible type of the local `window.api.pty.inspectProcess` leg.
type LocalInspectProcessResult = Awaited<ReturnType<PtyApi['inspectProcess']>>

function unverifiableChildren(foregroundProcess: string | null): RuntimeTerminalProcessInspection {
  return {
    foregroundProcess,
    hasChildProcesses: false,
    processEvidence: {
      foreground: { verdict: 'observed', processName: foregroundProcess },
      children: { verdict: 'unverifiable', reason: 'pgrep did not answer before its deadline' }
    }
  }
}

function unverifiableForeground(): RuntimeTerminalProcessInspection {
  return {
    foregroundProcess: null,
    hasChildProcesses: false,
    processEvidence: {
      foreground: { verdict: 'unverifiable', reason: 'ps did not answer before its deadline' },
      children: { verdict: 'exited' }
    }
  }
}

function confirmedExit(foregroundProcess: string | null): RuntimeTerminalProcessInspection {
  return {
    foregroundProcess,
    hasChildProcesses: false,
    processEvidence: {
      foreground: { verdict: 'observed', processName: foregroundProcess },
      children: { verdict: 'exited' }
    }
  }
}

/** Feeds one scripted inspection per poll, repeating the last step forever. */
function scripted(
  steps: RuntimeTerminalProcessInspection[]
): () => RuntimeTerminalProcessInspection {
  let index = 0
  return () => steps[Math.min(index++, steps.length - 1)]!
}

describe('agent completion with inspection evidence', () => {
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

  it('never turns unverifiable child evidence into a process-exit completion', async () => {
    let result: RuntimeTerminalProcessInspection = processResult('codex')
    const { dispatchCompletion } = startCoordinator(() => result)

    await vi.advanceTimersByTimeAsync(2_000)

    // The host stops being able to answer pgrep; codex may still be running.
    result = unverifiableChildren('zsh')
    await vi.advanceTimersByTimeAsync(60_000)

    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it('carries unverifiable evidence through the preload-typed local inspection result', async () => {
    // Pins the preload contract: `processEvidence` must exist on the renderer-
    // visible type of the local IPC leg, not only on the runtime-RPC shape —
    // otherwise a typed consumer cannot see the evidence the host published.
    let result: LocalInspectProcessResult = processResult('codex')
    const { dispatchCompletion } = startCoordinator(() => result)

    await vi.advanceTimersByTimeAsync(2_000)

    result = {
      foregroundProcess: 'zsh',
      hasChildProcesses: false,
      processEvidence: {
        foreground: { verdict: 'observed', processName: 'zsh' },
        children: { verdict: 'unverifiable', reason: 'pgrep did not answer before its deadline' }
      }
    }
    await vi.advanceTimersByTimeAsync(60_000)

    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it('never turns unverifiable foreground evidence into a process-exit completion', async () => {
    let result: RuntimeTerminalProcessInspection = processResult('codex')
    const { dispatchCompletion } = startCoordinator(() => result)

    await vi.advanceTimersByTimeAsync(2_000)

    result = unverifiableForeground()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it('keeps tracking a recognized agent whose child probe is unverifiable', async () => {
    let result: RuntimeTerminalProcessInspection = {
      foregroundProcess: 'codex',
      hasChildProcesses: false,
      processEvidence: {
        foreground: { verdict: 'observed', processName: 'codex' },
        children: { verdict: 'unverifiable', reason: 'pgrep could not run: ENOENT' }
      }
    }
    const { dispatchCompletion } = startCoordinator(() => result)

    await vi.advanceTimersByTimeAsync(4_000)
    expect(dispatchCompletion).not.toHaveBeenCalled()

    // Once the probes answer and positively observe the exit, the completion
    // still fires — recognition was not lost to the unverifiable child probe.
    result = confirmedExit('zsh')
    await vi.advanceTimersByTimeAsync(4_000)

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith('codex', {
      source: 'process-exit',
      quietedHookDone: false,
      terminalIdleConfirmed: true
    })
  })

  it('treats malformed evidence from a foreign host as unverifiable', async () => {
    let result: RuntimeTerminalProcessInspection = processResult('codex')
    const { dispatchCompletion } = startCoordinator(() => result)

    await vi.advanceTimersByTimeAsync(2_000)

    result = {
      foregroundProcess: null,
      hasChildProcesses: false,
      processEvidence: {
        foreground: { verdict: 'observed', processName: null },
        children: { verdict: 'someday-new-verdict' } as never
      }
    }
    await vi.advanceTimersByTimeAsync(60_000)

    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it('re-arms the two-sample exit confirmation after an unverifiable sample', async () => {
    // Completion needs two consecutive positively-exited samples. The
    // unverifiable sample in the middle observed nothing, so it cannot stand
    // in for either half of the pair: the pending exit it interrupts has to be
    // discarded, not carried across the gap to be confirmed by the next one.
    const { dispatchCompletion } = startCoordinator(
      scripted([
        processResult('codex'),
        confirmedExit('zsh'),
        unverifiableChildren('zsh'),
        confirmedExit('zsh'),
        unverifiableChildren('zsh')
      ])
    )

    await vi.advanceTimersByTimeAsync(120_000)

    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it('re-arms the two-sample exit confirmation after an unavailable sample too', async () => {
    // The twin of the case above, on the other arm. `unavailable` is the
    // transport saying it could not reach the host at all — strictly less
    // evidence than an out-of-contract verdict — so it must discard a pending
    // exit for the same reason. Reverting either arm's re-arm alone has to go
    // red, or one of the two is only held up by the other.
    const { dispatchCompletion } = startCoordinator(
      scripted([
        processResult('codex'),
        confirmedExit('zsh'),
        { foregroundProcess: null, hasChildProcesses: false, unavailable: true },
        confirmedExit('zsh'),
        { foregroundProcess: null, hasChildProcesses: false, unavailable: true }
      ])
    )

    await vi.advanceTimersByTimeAsync(120_000)

    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it('confirms the exit from two consecutive positively-exited samples', async () => {
    // The control for the re-arm above: the same script without the
    // unverifiable sample in the middle must complete, so the refusal there is
    // the interruption and not the sequence length.
    const { dispatchCompletion } = startCoordinator(
      scripted([
        processResult('codex'),
        confirmedExit('zsh'),
        confirmedExit('zsh'),
        unverifiableChildren('zsh')
      ])
    )

    await vi.advanceTimersByTimeAsync(120_000)

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith('codex', {
      source: 'process-exit',
      quietedHookDone: false,
      terminalIdleConfirmed: true
    })
  })

  it('keeps charging inspection errors while the host stays unverifiable', async () => {
    // The error count drives the poll backoff, and an unverifiable sample was
    // not a readable inspection: it must not reset the count on its way to
    // incrementing it, or the backoff stays pinned at a single error and the
    // client keeps hammering a host that has already said it cannot answer.
    const inspectedAt: number[] = []
    const next = scripted([processResult('codex'), unverifiableChildren('zsh')])
    const { dispatchCompletion } = startCoordinator(() => {
      inspectedAt.push(Date.now())
      return next()
    })

    await vi.advanceTimersByTimeAsync(120_000)

    expect(dispatchCompletion).not.toHaveBeenCalled()
    expect(inspectedAt.length).toBeGreaterThan(4)
    // The active tier polls every 750ms; a run of unverifiable samples has to
    // walk the backoff all the way up to its 10s ceiling.
    expect(inspectedAt.at(-1)! - inspectedAt.at(-2)!).toBeGreaterThanOrEqual(10_000)
  })

  it('keeps charging inspection errors while the host stays unavailable too', async () => {
    // The twin of the case above on the other arm. `unavailable` is the
    // transport failing to reach the host at all, so it is even less of a
    // readable inspection than an out-of-contract verdict: it has to walk the
    // same backoff, or the client polls an unreachable host at the active tier
    // forever.
    const inspectedAt: number[] = []
    const next = scripted([
      processResult('codex'),
      { foregroundProcess: null, hasChildProcesses: false, unavailable: true }
    ])
    const { dispatchCompletion } = startCoordinator(() => {
      inspectedAt.push(Date.now())
      return next()
    })

    await vi.advanceTimersByTimeAsync(120_000)

    expect(dispatchCompletion).not.toHaveBeenCalled()
    expect(inspectedAt.length).toBeGreaterThan(4)
    expect(inspectedAt.at(-1)! - inspectedAt.at(-2)!).toBeGreaterThanOrEqual(10_000)
  })

  it('still completes from legacy fields when the host predates evidence', async () => {
    // An old host publishes no processEvidence; its legacy answer remains the
    // only available reading and completion detection must keep working.
    let result: RuntimeTerminalProcessInspection = processResult('codex')
    const { dispatchCompletion } = startCoordinator(() => result)

    await vi.advanceTimersByTimeAsync(2_000)

    result = processResult(null, false)
    await vi.advanceTimersByTimeAsync(2_000)

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith('codex', {
      source: 'process-exit',
      quietedHookDone: false,
      terminalIdleConfirmed: true
    })
  })
})
