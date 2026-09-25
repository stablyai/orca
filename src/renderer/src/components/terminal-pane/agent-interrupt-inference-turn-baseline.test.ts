import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { createAgentInterruptInference } from './agent-interrupt-inference'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'

/** A Codex row whose main agent is mid-turn beside a working subagent. */
function makeEntry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'working',
    prompt: 'write tests',
    updatedAt: 1_000,
    stateStartedAt: 900,
    agentType: 'codex',
    paneKey: PANE_KEY,
    terminalTitle: 'Codex',
    stateHistory: [],
    mainAgent: { state: 'working', stateStartedAt: 900 },
    subagents: [{ id: 'agent-1', state: 'working', startedAt: 950 }],
    ...overrides
  }
}

function track(getEntry: () => AgentStatusEntry | undefined) {
  const inferInterrupt = vi.fn()
  const tracker = createAgentInterruptInference({
    paneKey: PANE_KEY,
    getStatusEntry: getEntry,
    inferInterrupt,
    now: () => 1_100
  })
  return { inferInterrupt, tracker }
}

describe('interrupt inference baselined on the main agent turn', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    ['a subagent hook', makeEntry({ updatedAt: 1_050 })],
    ['a same-state main agent restatement', makeEntry({ updatedAt: 1_050, toolName: 'Bash' })]
  ])('keeps a Ctrl+C when %s re-stamps the row in the settle window', (_label, next) => {
    vi.useFakeTimers()
    let entry = makeEntry()
    const { inferInterrupt, tracker } = track(() => entry)

    tracker.observeInputIntent('ctrl-c')
    entry = next
    vi.advanceTimersByTime(500)

    expect(inferInterrupt).toHaveBeenCalledWith({
      paneKey: PANE_KEY,
      baselineUpdatedAt: 1_000,
      baselineStateStartedAt: 900,
      baselinePrompt: 'write tests',
      baselineAgentType: 'codex',
      baselineMainAgentStateStartedAt: 900,
      intent: 'ctrl-c'
    })
    tracker.dispose()
  })

  it.each([
    [
      'a main agent Stop the subagent holds open',
      makeEntry({ updatedAt: 1_050, mainAgent: { state: 'done', stateStartedAt: 1_050 } })
    ],
    [
      'a settled row',
      makeEntry({
        state: 'done',
        updatedAt: 1_050,
        stateStartedAt: 1_050,
        mainAgent: { state: 'done', stateStartedAt: 1_050 },
        subagents: undefined
      })
    ],
    [
      'a new prompt',
      makeEntry({
        prompt: 'next task',
        updatedAt: 1_050,
        mainAgent: { state: 'working', stateStartedAt: 1_050 }
      })
    ],
    [
      'a new turn with the same prompt',
      makeEntry({ updatedAt: 1_050, mainAgent: { state: 'working', stateStartedAt: 1_050 } })
    ],
    [
      'a main agent permission wait',
      makeEntry({
        state: 'waiting',
        updatedAt: 1_050,
        stateStartedAt: 1_050,
        mainAgent: { state: 'waiting', stateStartedAt: 1_050 }
      })
    ]
  ])('drops a Ctrl+C when %s lands in the settle window', (_label, next) => {
    vi.useFakeTimers()
    let entry = makeEntry()
    const { inferInterrupt, tracker } = track(() => entry)

    tracker.observeInputIntent('ctrl-c')
    entry = next
    vi.advanceTimersByTime(500)

    expect(inferInterrupt).not.toHaveBeenCalled()
    tracker.dispose()
  })

  it('keeps the row write time for a host that publishes no main agent', () => {
    vi.useFakeTimers()
    let entry = makeEntry({ mainAgent: undefined })
    const { inferInterrupt, tracker } = track(() => entry)

    tracker.observeInputIntent('ctrl-c')
    entry = makeEntry({ mainAgent: undefined, updatedAt: 1_050 })
    vi.advanceTimersByTime(500)

    expect(inferInterrupt).not.toHaveBeenCalled()
    tracker.dispose()
  })

  it('omits the main agent baseline when the main agent was not working at the keypress', () => {
    vi.useFakeTimers()
    const entry = makeEntry({ mainAgent: { state: 'done', stateStartedAt: 950 } })
    const { inferInterrupt, tracker } = track(() => entry)

    tracker.observeInputIntent('ctrl-c')
    vi.advanceTimersByTime(500)

    expect(inferInterrupt).toHaveBeenCalledWith(
      expect.not.objectContaining({ baselineMainAgentStateStartedAt: expect.anything() })
    )
    tracker.dispose()
  })

  it('infers an acknowledged Codex Esc when a subagent hook replaced the row before the ack', () => {
    const captured = makeEntry()
    const current = makeEntry({ updatedAt: 1_050 })
    const { inferInterrupt, tracker } = track(() => current)

    tracker.observeInputIntent('plain-escape', captured, 1)

    expect(inferInterrupt).toHaveBeenCalledWith(
      expect.objectContaining({
        baselineUpdatedAt: 1_000,
        baselineMainAgentStateStartedAt: 900,
        intent: 'plain-escape'
      })
    )
    tracker.dispose()
  })

  it('drops an acknowledged Codex Esc when a new main agent turn replaced the row before the ack', () => {
    const captured = makeEntry()
    const current = makeEntry({
      updatedAt: 1_050,
      mainAgent: { state: 'working', stateStartedAt: 1_050 }
    })
    const { inferInterrupt, tracker } = track(() => current)

    tracker.observeInputIntent('plain-escape', captured, 1)

    expect(inferInterrupt).not.toHaveBeenCalled()
    tracker.dispose()
  })
})
