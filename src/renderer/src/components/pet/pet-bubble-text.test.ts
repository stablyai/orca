import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry, AgentStatusState } from '../../../../shared/agent-status-types'
import {
  formatPetBubbleText,
  pickPetBubbleLine,
  selectPetBubbleWinner
} from './pet-bubble-text'

const NOW = 1_000
const STALE_AFTER_MS = 500

function entry(state: AgentStatusState, overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
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

describe('selectPetBubbleWinner', () => {
  it('returns null when nothing fresh is happening', () => {
    expect(selectPetBubbleWinner([], NOW, STALE_AFTER_MS)).toBeNull()
    expect(selectPetBubbleWinner([entry('done', { stateStartedAt: NOW - 2000 })], NOW, STALE_AFTER_MS)).toBeNull()
  })

  it('attributes waiting to the agentType on the entry', () => {
    const winner = selectPetBubbleWinner(
      [entry('blocked', { agentType: 'grok' })],
      NOW,
      STALE_AFTER_MS
    )
    expect(winner).toEqual({ mood: 'waiting', agentType: 'grok', count: 1 })
  })

  it('prioritizes waiting over a fresher failed/waving/running signal', () => {
    const winner = selectPetBubbleWinner(
      [
        entry('working', { paneKey: 'a', agentType: 'codex' }),
        entry('done', { paneKey: 'b', interrupted: true, agentType: 'claude' }),
        entry('done', { paneKey: 'c', agentType: 'hermes' }),
        entry('blocked', { paneKey: 'd', agentType: 'grok' })
      ],
      NOW,
      STALE_AFTER_MS
    )
    expect(winner?.mood).toBe('waiting')
    expect(winner?.agentType).toBe('grok')
  })

  it('pins to one paneKey deterministically and counts the rest sharing the mood', () => {
    const winner = selectPetBubbleWinner(
      [
        entry('blocked', { paneKey: 'zzz', agentType: 'codex' }),
        entry('waiting', { paneKey: 'aaa', agentType: 'grok' }),
        entry('blocked', { paneKey: 'mmm', agentType: 'claude' })
      ],
      NOW,
      STALE_AFTER_MS
    )
    expect(winner).toEqual({ mood: 'waiting', agentType: 'grok', count: 3 })
  })

  it('does not treat an interrupted completion as a celebration', () => {
    const winner = selectPetBubbleWinner(
      [entry('done', { interrupted: true, agentType: 'codex' })],
      NOW,
      STALE_AFTER_MS
    )
    expect(winner).toEqual({ mood: 'failed', agentType: 'codex', count: 1 })
  })

  it('falls back to running when only work is in flight', () => {
    const winner = selectPetBubbleWinner([entry('working', { agentType: 'omp' })], NOW, STALE_AFTER_MS)
    expect(winner).toEqual({ mood: 'running', agentType: 'omp', count: 1 })
  })
})

describe('formatPetBubbleText', () => {
  it('composes agent label + mood line with no suffix for a lone winner', () => {
    const text = formatPetBubbleText(
      { mood: 'waiting', agentType: 'grok', count: 1 },
      'waiting…',
      (n) => `+${n}`
    )
    expect(text).toBe('Grok waiting…')
  })

  it('appends a +N suffix for extra agents sharing the mood', () => {
    const text = formatPetBubbleText(
      { mood: 'waiting', agentType: 'grok', count: 3 },
      'waiting…',
      (n) => `+${n}`
    )
    expect(text).toBe('Grok waiting… +2')
  })

  it('labels an unattributed/unknown agent generically', () => {
    const text = formatPetBubbleText(
      { mood: 'running', agentType: undefined, count: 1 },
      'working…',
      (n) => `+${n}`
    )
    expect(text).toBe('Agent working…')
  })
})

describe('pickPetBubbleLine', () => {
  it('returns the only line when there is just one', () => {
    expect(pickPetBubbleLine(['only'], 'only')).toBe('only')
  })

  it('never immediately repeats the previous line when alternatives exist', () => {
    for (let i = 0; i < 20; i++) {
      expect(pickPetBubbleLine(['a', 'b'], 'a')).toBe('b')
    }
  })
})
