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

  it('does not count an OpenCode Escape across a new turn', () => {
    vi.useFakeTimers()
    let entry: AgentStatusEntry | undefined = makeEntry({ agentType: 'opencode' })
    const inferInterrupt = vi.fn()
    const tracker = createAgentInterruptInference({
      paneKey: PANE_KEY,
      getStatusEntry: () => entry,
      inferInterrupt,
      now: () => 1_100
    })

    tracker.observeInputIntent('plain-escape')
    entry = makeEntry({ agentType: 'opencode', prompt: 'second task', stateStartedAt: 1_050 })
    tracker.observeInputIntent('plain-escape')
    vi.runOnlyPendingTimers()

    expect(inferInterrupt).not.toHaveBeenCalled()
    tracker.dispose()
    entry = undefined
  })

  it.each([['claude'], ['omp'], ['pi'], ['prime-agent']] as const)(
    'keeps a pending Ctrl+C for %s when a navigation Escape lands before it settles',
    (agentType) => {
      // Escape may dismiss UI but must not revoke a Ctrl+C already waiting to settle.
      vi.useFakeTimers()
      let entry: AgentStatusEntry | undefined = makeEntry({ agentType, toolName: 'Bash' })
      const inferInterrupt = vi.fn().mockReturnValue(true)
      const tracker = createAgentInterruptInference({
        paneKey: PANE_KEY,
        getStatusEntry: () => entry,
        inferInterrupt,
        now: () => 1_100
      })

      tracker.observeInputIntent('ctrl-c')
      tracker.observeInputIntent('plain-escape')
      vi.advanceTimersByTime(500)

      expect(inferInterrupt).toHaveBeenCalledTimes(1)
      expect(inferInterrupt).toHaveBeenCalledWith(
        expect.objectContaining({ paneKey: PANE_KEY, intent: 'ctrl-c' })
      )
      tracker.dispose()
      entry = undefined
    }
  )

  it('cancels when a newer hook update arrives during the settle window', () => {
    vi.useFakeTimers()
    const inferInterrupt = vi.fn()
    let entry: AgentStatusEntry | undefined = makeEntry({ agentType: 'custom-agent' })
    const tracker = createAgentInterruptInference({
      paneKey: PANE_KEY,
      getStatusEntry: () => entry,
      inferInterrupt,
      now: () => 1_100
    })

    tracker.observeInputIntent('plain-escape')
    entry = makeEntry({ updatedAt: 1_001 })
    vi.advanceTimersByTime(500)

    expect(inferInterrupt).not.toHaveBeenCalled()
    tracker.dispose()
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
