import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry, AgentStatusState } from '../../../../shared/agent-status-types'
import { summarizeSleepyModeFleet } from './sleepy-mode-fleet-summary'

const NOW = 1_000
const STALE_AFTER_MS = 500

function entry(
  state: AgentStatusState,
  overrides: Partial<AgentStatusEntry> = {}
): AgentStatusEntry {
  return {
    state,
    prompt: '',
    updatedAt: NOW,
    stateStartedAt: NOW,
    paneKey: `tab:${state}`,
    stateHistory: [],
    ...overrides
  }
}

function summarize(entries: AgentStatusEntry[]) {
  return summarizeSleepyModeFleet({ entries, now: NOW, staleAfterMs: STALE_AFTER_MS })
}

describe('summarizeSleepyModeFleet', () => {
  it('counts nothing for an empty fleet', () => {
    expect(summarize([])).toEqual({ working: 0, waiting: 0, done: 0 })
  })

  it('counts blocked alongside waiting', () => {
    expect(summarize([entry('waiting'), entry('blocked', { paneKey: 'tab:blocked' })])).toEqual({
      working: 0,
      waiting: 2,
      done: 0
    })
  })

  it('ignores stale rows so a finished night does not read as busy', () => {
    expect(summarize([entry('working', { updatedAt: NOW - STALE_AFTER_MS - 1 })])).toEqual({
      working: 0,
      waiting: 0,
      done: 0
    })
  })

  it('does not count monitoring turns as work', () => {
    expect(summarize([entry('working', { workingMode: 'monitoring' })])).toEqual({
      working: 0,
      waiting: 0,
      done: 0
    })
  })

  it('counts a mixed fleet', () => {
    expect(
      summarize([
        entry('working', { paneKey: 'a' }),
        entry('working', { paneKey: 'b' }),
        entry('waiting', { paneKey: 'c' }),
        entry('done', { paneKey: 'd' })
      ])
    ).toEqual({ working: 2, waiting: 1, done: 1 })
  })
})
