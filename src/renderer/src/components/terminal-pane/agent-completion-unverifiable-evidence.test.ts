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
