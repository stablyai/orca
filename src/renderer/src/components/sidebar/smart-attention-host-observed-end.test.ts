import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { IDLE, mostRecentAttentionInHistory, resolveAttention } from './smart-attention'

const NOW = new Date('2026-03-27T12:00:00.000Z').getTime()

type Verdict = 'interruption' | 'unconfirmed' | 'cancellation'

function doneEntry(outcome: Verdict): AgentStatusEntry {
  return {
    state: 'done',
    prompt: '',
    updatedAt: NOW - 30_000,
    stateStartedAt: NOW - 90_000,
    agentType: 'codex',
    paneKey: 't:1',
    stateHistory: [],
    mainAgent: { state: 'done', outcome, stateStartedAt: NOW - 90_000 }
  }
}

// A crash nobody asked for and an end Orca cannot prove are news the user has not seen; only the
// user's own stop is demoted.
describe('attention for a turn end the host observed', () => {
  it.each(['interruption', 'unconfirmed'] as const)(
    'ranks an %s done in Class 2 at its end time, like a completion, where a stop is demoted',
    (outcome) => {
      const at = (verdict: Verdict) =>
        resolveAttention([{ kind: 'hook', entry: doneEntry(verdict), hasLivePty: false }], NOW)
      expect(at(outcome)).toEqual({ cls: 2, attentionTimestamp: NOW - 90_000 })
      expect(at('cancellation')).toEqual(IDLE)
    }
  )

  it.each(['interruption', 'unconfirmed'] as const)(
    'counts an %s history done as attention, where a stop is skipped',
    (outcome) => {
      const latest = (verdict: Verdict) =>
        mostRecentAttentionInHistory([
          { state: 'done', prompt: '', startedAt: NOW - 4_000 },
          {
            state: 'done',
            prompt: '',
            startedAt: NOW - 1_000,
            mainAgent: { state: 'done', outcome: verdict, stateStartedAt: NOW - 1_000 }
          }
        ])
      expect(latest(outcome)).toBe(NOW - 1_000)
      expect(latest('cancellation')).toBe(NOW - 4_000)
    }
  )
})
