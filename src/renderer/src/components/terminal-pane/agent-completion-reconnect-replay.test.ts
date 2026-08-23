import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createAgentCompletionCoordinator,
  resetAgentCompletionCoordinatorIdentitiesForTest
} from './agent-completion-coordinator'
import type { AgentCompletionStatusSnapshot } from './agent-completion-coordinator-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'

const PANE = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const T0 = 1_700_000_000_000
const PROMPT = 'ship the release notes'

function row(state: 'working' | 'done', stateStartedAt: number): AgentCompletionStatusSnapshot {
  return { state, prompt: PROMPT, agentType: 'claude', stateStartedAt }
}

function trackCompletions(): {
  observe: (snapshot: AgentCompletionStatusSnapshot) => void
  count: () => number
  dispose: () => void
} {
  const completions: string[] = []
  const coordinator = createAgentCompletionCoordinator({
    paneKey: PANE,
    getPtyId: () => 'pty-1',
    getSettings: () => null,
    inspectProcess: async () => ({ foregroundProcess: null, hasChildProcesses: false }),
    dispatchCompletion: (title) => {
      completions.push(title)
    },
    isLive: () => true
  })
  return {
    observe: (snapshot) => coordinator.observeHookStatus(snapshot),
    count: () => completions.length,
    dispose: () => coordinator.dispose()
  }
}

/** The renderer's only defence against a repeated `done` is the turn identity
 *  `state:agentType:stateStartedAt`. These cases pin what a reconnect replay must and must
 *  not carry for that defence to hold — the contract `reconnect-clear-replay-turn-identity.test.ts`
 *  enforces on the main-process side (STA-3524). */
describe('reconnect replay and the completion turn identity', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    resetAgentCompletionCoordinatorIdentitiesForTest()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetAgentCompletionCoordinatorIdentitiesForTest()
  })

  it('re-fires the notification when a replayed done arrives with a re-minted stateStartedAt', () => {
    const notifications = trackCompletions()
    notifications.observe(row('working', T0))
    vi.setSystemTime(T0 + 5_000)
    notifications.observe(row('done', T0 + 5_000))
    vi.advanceTimersByTime(5_000)
    expect(notifications.count()).toBe(1)

    // What a clear + replay produced before the fix: the same finished turn, restamped.
    vi.setSystemTime(T0 + 61_000)
    notifications.observe(row('done', T0 + 61_000))
    vi.advanceTimersByTime(5_000)

    expect(notifications.count()).toBe(2)
    notifications.dispose()
  })

  it('stays silent when the replayed done keeps the turn identity it was notified under', () => {
    const notifications = trackCompletions()
    notifications.observe(row('working', T0))
    vi.setSystemTime(T0 + 5_000)
    notifications.observe(row('done', T0 + 5_000))
    vi.advanceTimersByTime(5_000)
    expect(notifications.count()).toBe(1)

    vi.setSystemTime(T0 + 61_000)
    notifications.observe(row('done', T0 + 5_000))
    vi.advanceTimersByTime(5_000)

    expect(notifications.count()).toBe(1)
    notifications.dispose()
  })

  it('stays silent across repeated reconnect cycles replaying the same turn', () => {
    const notifications = trackCompletions()
    notifications.observe(row('working', T0))
    vi.setSystemTime(T0 + 5_000)
    notifications.observe(row('done', T0 + 5_000))
    vi.advanceTimersByTime(5_000)

    // The reported symptom is a flap: dozens of replays in a few minutes.
    for (let cycle = 1; cycle <= 12; cycle += 1) {
      vi.setSystemTime(T0 + 60_000 + cycle * 10_000)
      notifications.observe(row('done', T0 + 5_000))
      vi.advanceTimersByTime(5_000)
    }

    expect(notifications.count()).toBe(1)
    notifications.dispose()
  })

  it('still notifies a completion first seen on the replay', () => {
    const notifications = trackCompletions()
    notifications.observe(row('working', T0))
    expect(notifications.count()).toBe(0)

    // The turn ended while the client was disconnected, so this done is new to the pane.
    vi.setSystemTime(T0 + 61_000)
    notifications.observe(row('done', T0 + 61_000))
    vi.advanceTimersByTime(5_000)

    expect(notifications.count()).toBe(1)
    notifications.dispose()
  })

  it('notifies again for a real next turn after the replayed one', () => {
    const notifications = trackCompletions()
    notifications.observe(row('working', T0))
    vi.setSystemTime(T0 + 5_000)
    notifications.observe(row('done', T0 + 5_000))
    vi.setSystemTime(T0 + 61_000)
    notifications.observe(row('done', T0 + 5_000))
    vi.advanceTimersByTime(5_000)
    expect(notifications.count()).toBe(1)

    vi.setSystemTime(T0 + 70_000)
    notifications.observe(row('working', T0 + 70_000))
    vi.setSystemTime(T0 + 80_000)
    notifications.observe(row('done', T0 + 80_000))
    vi.advanceTimersByTime(5_000)

    expect(notifications.count()).toBe(2)
    notifications.dispose()
  })
})
