import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import { createAgentInterruptInference } from './agent-interrupt-inference'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'

function makeEntry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'working',
    prompt: 'write tests',
    updatedAt: 1_000,
    stateStartedAt: 900,
    agentType: 'custom-agent',
    paneKey: PANE_KEY,
    terminalTitle: 'Codex',
    stateHistory: [],
    ...overrides
  }
}

describe('agent interrupt inference', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    ['an older status', makeEntry()],
    ['an absent status', null]
  ] as const)(
    'does not let a delayed acknowledgment for %s cancel a newer turn after cleanup',
    (_label, olderEntry) => {
      vi.useFakeTimers()
      const newerEntry = makeEntry({
        prompt: 'newer task',
        updatedAt: 2_000,
        stateStartedAt: 1_900
      })
      let currentEntry: AgentStatusEntry | undefined = newerEntry
      const inferInterrupt = vi.fn()
      const tracker = createAgentInterruptInference({
        paneKey: PANE_KEY,
        getStatusEntry: () => currentEntry,
        inferInterrupt,
        now: () => 2_100
      })

      tracker.observeInputIntent('plain-escape', newerEntry, 2)
      currentEntry = undefined
      tracker.observeInputIntent('plain-escape', olderEntry, 1)
      vi.advanceTimersByTime(500)

      expect(inferInterrupt).toHaveBeenCalledWith({
        paneKey: PANE_KEY,
        baselineUpdatedAt: 2_000,
        baselineStateStartedAt: 1_900,
        baselinePrompt: 'newer task',
        baselineAgentType: 'custom-agent',
        intent: 'plain-escape'
      })
    }
  )
})
