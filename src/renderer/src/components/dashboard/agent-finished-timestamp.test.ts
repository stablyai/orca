import { describe, expect, it } from 'vitest'
import { agentEntryCompletionAt } from '../../../../shared/agent-completion-time'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { lastEnteredDoneAt } from './agent-finished-timestamp'

function row(entry: AgentStatusEntry) {
  return { rowSource: 'live' as const, state: entry.state, entry }
}

function doneEntry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
    state: 'done',
    prompt: '',
    updatedAt: 2_000,
    stateStartedAt: 2_000,
    stateHistory: [],
    agentType: 'claude',
    ...overrides
  }
}

describe('lastEnteredDoneAt session boundaries (STA-3386)', () => {
  it('does not report an idle SessionStart as a completed turn', () => {
    expect(lastEnteredDoneAt(row(doneEntry({ sessionBoundary: true })))).toBeNull()
  })

  it('falls through to a real completion displaced into history', () => {
    expect(
      lastEnteredDoneAt(
        row(
          doneEntry({
            sessionBoundary: true,
            stateHistory: [{ state: 'done', prompt: 'Real turn', startedAt: 1_000 }]
          })
        )
      )
    ).toBe(1_000)
  })
})

describe('lastEnteredDoneAt shares the Smart Sort completion clock', () => {
  it('times an ordinary completion from stateStartedAt, not updatedAt', () => {
    const entry = doneEntry({ stateStartedAt: 2_000, updatedAt: 190_000 })
    expect(lastEnteredDoneAt(row(entry))).toBe(2_000)
    expect(agentEntryCompletionAt(entry)).toBe(2_000)
  })

  it('still shows when an interrupted turn stopped, though it never ranks as done', () => {
    const entry = doneEntry({ interrupted: true, stateStartedAt: 2_000 })
    expect(lastEnteredDoneAt(row(entry))).toBe(2_000)
    expect(agentEntryCompletionAt(entry)).toBeNull()
  })
})
