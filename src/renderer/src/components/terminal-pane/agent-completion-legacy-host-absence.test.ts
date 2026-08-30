import { describe, expect, it, vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import {
  processResult,
  useAgentCompletionCoordinatorLifecycle
} from './agent-completion-coordinator-test-harness'
import { composeLegacyPtyProcessInspection } from '../../../../shared/pty-process-inspection-evidence'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'

// The real producer: `DaemonPtyProcessInspection.inspectProcess` returns this
// verbatim for a daemon at protocol 11..26 (adopted across in-place app updates
// via PREVIOUS_DAEMON_PROTOCOL_VERSIONS), and `orca-runtime.inspectTerminalProcess`
// composes the same evidence-less pair from its two-call fallback.
function legacyHostInspection(foregroundProcess: string | null): RuntimeTerminalProcessInspection {
  return composeLegacyPtyProcessInspection(foregroundProcess)
}

function publishedExit(foregroundProcess: string | null): RuntimeTerminalProcessInspection {
  return {
    foregroundProcess,
    hasChildProcesses: false,
    processEvidence: {
      foreground: { verdict: 'observed', processName: foregroundProcess },
      children: { verdict: 'exited' }
    }
  }
}

describe('agent completion against a host that publishes no process evidence', () => {
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

  it('never reports the agent finished from a shell name such a host cannot vouch for', async () => {
    // The ordinary shape, and the one the null fixture omits: the pane's
    // foreground read fell back to the shell TITLE. `observeForegroundProcess`
    // on a current daemon calls exactly this state `unverifiable` ("shell title
    // without a corroborating foreground scan") — but a pre-v27 daemon has no
    // field to say so, and publishes the same `zsh` + `false` it publishes for a
    // genuinely idle pane. Spending it as a confirmed exit reports a running
    // agent as complete, on the one path whose response is to walk away.
    let result: RuntimeTerminalProcessInspection = processResult('codex')
    const { dispatchCompletion } = startCoordinator(() => result)

    await vi.advanceTimersByTimeAsync(2_000)

    result = legacyHostInspection('zsh')
    await vi.advanceTimersByTimeAsync(60_000)

    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it('never reports it finished from the same host answering no foreground at all', async () => {
    // The other legacy collapse, and the twin of the shape above: `null` is
    // what such a host publishes both when it watched the pty die and when its
    // title read returned nothing usable. One rule has to cover both halves, or
    // the boolean the name derives keeps riding an `observed` verdict.
    let result: RuntimeTerminalProcessInspection = processResult('codex')
    const { dispatchCompletion } = startCoordinator(() => result)

    await vi.advanceTimersByTimeAsync(2_000)

    result = legacyHostInspection(null)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it('still tracks an agent such a host reports positively', async () => {
    // The preserved direction: a non-shell foreground is the one thing an
    // evidence-less host says unambiguously, so recognition must survive the
    // refusal above — otherwise the pane stops being watched at all.
    const { dispatchCompletion } = startCoordinator(() => legacyHostInspection('codex'))

    await vi.advanceTimersByTimeAsync(4_000)

    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it('does not charge such a host the inspection error backoff for having answered', async () => {
    // Why this is a separate test and not a shape preference: the refusal above
    // must come from the EXIT conjunct alone. Reading the absence-aware rule at the
    // top of `handleInspectionResult` instead would make `zsh` from this host look
    // like a failed inspection, and `consecutiveInspectionErrors` forces the poll
    // interval to >=10s and re-increments on every later answer, so it never
    // recovers. The host ANSWERED; it just cannot vouch for the answer. Collapsing
    // the two reads into one costs this pane ~13x its watch rate, which is the
    // opposite of what refusing to trust it is for.
    let result: RuntimeTerminalProcessInspection = processResult('codex')
    const inspectProcess = vi.fn(async () => result)
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess,
      dispatchCompletion: vi.fn(),
      isLive: () => true,
      shouldPollProcessCadence: () => true
    })

    coordinator.startProcessTracking()
    await vi.advanceTimersByTimeAsync(2_000)

    result = legacyHostInspection('zsh')
    const before = inspectProcess.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)

    // Full 750ms cadence is ~78 over the window; the >=10s error backoff would
    // yield <=6. The gap between the two shapes is what this pins.
    expect(inspectProcess.mock.calls.length - before).toBeGreaterThanOrEqual(60)
  })

  it('still reports the exit a host that published evidence positively observed', async () => {
    // The control for the refusal: completion is not disabled, it is keyed on
    // the host having actually said `exited`.
    let result: RuntimeTerminalProcessInspection = processResult('codex')
    const { dispatchCompletion } = startCoordinator(() => result)

    await vi.advanceTimersByTimeAsync(2_000)

    result = publishedExit('zsh')
    await vi.advanceTimersByTimeAsync(4_000)

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith('codex', {
      source: 'process-exit',
      quietedHookDone: false,
      terminalIdleConfirmed: true
    })
  })
})
