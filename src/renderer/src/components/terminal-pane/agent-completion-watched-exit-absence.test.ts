import { describe, expect, it, vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import {
  processResult,
  useAgentCompletionCoordinatorLifecycle
} from './agent-completion-coordinator-test-harness'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'
// Why the real producer and not a literal: the existing monitor suites hand-write the
// pre-fix `{ null, false, unavailable: true }` absence shape, which the local provider no
// longer emits for a watched exit. A literal stays green through exactly the drift these
// cases exist to catch, so these read the host's own builder.
import { buildAbsentPtyInspection } from '../../../../shared/pty-process-inspection-evidence'

/** Feeds one scripted inspection per poll, repeating the last step forever. */
function scripted(
  steps: RuntimeTerminalProcessInspection[]
): () => RuntimeTerminalProcessInspection {
  let index = 0
  return () => steps[Math.min(index++, steps.length - 1)]!
}

const watchedExit = (): RuntimeTerminalProcessInspection => buildAbsentPtyInspection('exited')
const lostRoute = (): RuntimeTerminalProcessInspection => buildAbsentPtyInspection('unverifiable')

describe('agent completion on a PTY the host has no handle for', () => {
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

  it('completes the agent run from a local exit the provider watched', async () => {
    // The delta this PR carries into the monitor: before the absence shapes were told
    // apart, a watched exit arrived as `unavailable` and re-armed forever, so an agent
    // whose process simply ended never produced a completion.
    const { dispatchCompletion } = startCoordinator(
      scripted([processResult('codex'), watchedExit(), watchedExit()])
    )

    await vi.advanceTimersByTimeAsync(120_000)

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith('codex', {
      source: 'process-exit',
      quietedHookDone: false,
      terminalIdleConfirmed: true
    })
  })

  it('never completes the agent run from a route the host lost', async () => {
    const { dispatchCompletion } = startCoordinator(scripted([processResult('codex'), lostRoute()]))

    await vi.advanceTimersByTimeAsync(120_000)

    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it('re-arms the two-sample confirmation when a lost route interrupts a watched exit', async () => {
    // A lost route observed nothing, so it cannot stand in for either half of the pair.
    const { dispatchCompletion } = startCoordinator(
      scripted([processResult('codex'), watchedExit(), lostRoute(), watchedExit(), lostRoute()])
    )

    await vi.advanceTimersByTimeAsync(120_000)

    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it('walks the inspection backoff while the host keeps losing the route', async () => {
    // A lost route is not a readable inspection: it has to charge the error count that
    // drives the backoff, or the client polls an unreachable host at the active tier forever.
    const inspectedAt: number[] = []
    const next = scripted([processResult('codex'), lostRoute()])
    const { dispatchCompletion } = startCoordinator(() => {
      inspectedAt.push(Date.now())
      return next()
    })

    await vi.advanceTimersByTimeAsync(120_000)

    expect(dispatchCompletion).not.toHaveBeenCalled()
    expect(inspectedAt.length).toBeGreaterThan(4)
    expect(inspectedAt.at(-1)! - inspectedAt.at(-2)!).toBeGreaterThanOrEqual(10_000)
  })
})
