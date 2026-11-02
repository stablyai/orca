import { describe, expect, it } from 'vitest'
import {
  classifySortStampEvent,
  hookRowAgentPhase,
  nextAgentPaneState,
  RECENT_STAMP_THROTTLE_MS,
  REST_PANE,
  titleAgentPhase,
  workspaceSmartStamp,
  type AgentPaneState,
  type AgentPhase,
  type SortStamps
} from './sort-stamps'

const NOW = 1_000_000
const IDLE: SortStamps = { recentAt: NOW - 60_000 }

function agentEvent(from: AgentPhase, to: AgentPhase, panes: AgentPaneState[]) {
  return { kind: 'agent' as const, from, to, panes }
}

describe('hookRowAgentPhase', () => {
  it('maps hook states to tiers, and a stopped turn to Rest', () => {
    expect(hookRowAgentPhase({ state: 'working' })).toBe('working')
    expect(hookRowAgentPhase({ state: 'blocked' })).toBe('needs-you')
    expect(hookRowAgentPhase({ state: 'waiting' })).toBe('needs-you')
    expect(hookRowAgentPhase({ state: 'done' })).toBe('done')
    expect(hookRowAgentPhase({ state: 'done', interrupted: true })).toBe('rest')
    expect(
      hookRowAgentPhase({ state: 'done', mainAgent: { state: 'done', outcome: 'cancellation' } })
    ).toBe('rest')
    // An error is news: it ranks as Done, like a finish.
    expect(
      hookRowAgentPhase({ state: 'done', mainAgent: { state: 'done', outcome: 'failure' } })
    ).toBe('done')
  })
})

describe('titleAgentPhase', () => {
  it('reads the title heuristic Smart uses', () => {
    expect(titleAgentPhase('⠋ Codex working')).toBe('working')
    expect(titleAgentPhase('zsh')).toBe('rest')
  })
})

describe('nextAgentPaneState', () => {
  it('enters a phase at now', () => {
    expect(nextAgentPaneState(REST_PANE, 'working', NOW)).toEqual({ phase: 'working', at: NOW })
  })

  it('keeps the same object when the phase holds, so running stays running', () => {
    const working = { phase: 'working' as const, at: NOW - 5 }
    expect(nextAgentPaneState(working, 'working', NOW)).toBe(working)
  })

  it('reaches Done only from a turn', () => {
    expect(nextAgentPaneState(REST_PANE, 'done', NOW)).toBe(REST_PANE)
    expect(nextAgentPaneState({ phase: 'working', at: 1 }, 'done', NOW)).toEqual({
      phase: 'done',
      at: NOW
    })
    expect(nextAgentPaneState({ phase: 'needs-you', at: 1 }, 'done', NOW)).toEqual({
      phase: 'done',
      at: NOW
    })
  })

  it('keeps the time an approval was asked when the turn resumes', () => {
    expect(nextAgentPaneState({ phase: 'needs-you', at: 7 }, 'working', NOW)).toEqual({
      phase: 'working',
      at: 7
    })
  })
})

describe('workspaceSmartStamp', () => {
  it('takes the most demanding pane and that tier’s latest entry', () => {
    expect(workspaceSmartStamp([])).toEqual({})
    expect(
      workspaceSmartStamp([
        { phase: 'working', at: 9 },
        { phase: 'done', at: 3 },
        { phase: 'done', at: 5 }
      ])
    ).toEqual({ smartTier: 'done', smartAt: 5 })
    expect(
      workspaceSmartStamp([
        { phase: 'done', at: 9 },
        { phase: 'needs-you', at: 2 }
      ])
    ).toEqual({ smartTier: 'needs-you', smartAt: 2 })
  })
})

describe('classifySortStampEvent', () => {
  it('stamps a prompt from rest: Recent now, Working now', () => {
    const working = { phase: 'working' as const, at: NOW }
    expect(classifySortStampEvent(IDLE, agentEvent('rest', 'working', [working]), NOW)).toEqual({
      recentAt: NOW,
      smartTier: 'working',
      smartAt: NOW
    })
  })

  it('stamps a finish and a request for input', () => {
    const current: SortStamps = { recentAt: NOW - 60_000, smartTier: 'working', smartAt: 1 }
    expect(
      classifySortStampEvent(
        current,
        agentEvent('working', 'done', [{ phase: 'done', at: NOW }]),
        NOW
      )
    ).toEqual({ recentAt: NOW, smartTier: 'done', smartAt: NOW })
    expect(
      classifySortStampEvent(
        current,
        agentEvent('working', 'needs-you', [{ phase: 'needs-you', at: NOW }]),
        NOW
      )
    ).toEqual({ recentAt: NOW, smartTier: 'needs-you', smartAt: NOW })
  })

  it('stamps a new prompt after Done', () => {
    const current: SortStamps = { recentAt: NOW - 60_000, smartTier: 'done', smartAt: 1 }
    expect(
      classifySortStampEvent(
        current,
        agentEvent('done', 'working', [{ phase: 'working', at: NOW }]),
        NOW
      )
    ).toEqual({ recentAt: NOW, smartTier: 'working', smartAt: NOW })
  })

  it('moves a resumed approval to Working without a Recent stamp, keeping its time', () => {
    const current: SortStamps = { recentAt: NOW - 60_000, smartTier: 'needs-you', smartAt: 7 }
    expect(
      classifySortStampEvent(
        current,
        agentEvent('needs-you', 'working', [{ phase: 'working', at: 7 }]),
        NOW
      )
    ).toEqual({ recentAt: NOW - 60_000, smartTier: 'working', smartAt: 7 })
  })

  it('drops to Rest without a Recent stamp when the agent leaves', () => {
    const current: SortStamps = { recentAt: NOW - 60_000, smartTier: 'done', smartAt: 1 }
    expect(classifySortStampEvent(current, agentEvent('done', 'rest', []), NOW)).toEqual({
      recentAt: NOW - 60_000
    })
  })

  it('keeps the tier another pane holds', () => {
    const current: SortStamps = { recentAt: NOW - 60_000, smartTier: 'needs-you', smartAt: 3 }
    const panes = [
      { phase: 'needs-you' as const, at: 3 },
      { phase: 'done' as const, at: NOW }
    ]
    expect(classifySortStampEvent(current, agentEvent('working', 'done', panes), NOW)).toEqual({
      recentAt: NOW,
      smartTier: 'needs-you',
      smartAt: 3
    })
  })

  it('skips a Recent stamp within the throttle, but applies the tier at once', () => {
    const current: SortStamps = { recentAt: NOW - RECENT_STAMP_THROTTLE_MS + 1 }
    const working = { phase: 'working' as const, at: NOW }
    expect(classifySortStampEvent(current, agentEvent('rest', 'working', [working]), NOW)).toEqual({
      recentAt: current.recentAt,
      smartTier: 'working',
      smartAt: NOW
    })
    expect(classifySortStampEvent(current, { kind: 'bell' }, NOW)).toBeNull()
    expect(
      classifySortStampEvent(
        { recentAt: NOW - RECENT_STAMP_THROTTLE_MS },
        { kind: 'terminal-started' },
        NOW
      )
    ).toEqual({ recentAt: NOW })
  })

  it('keeps the tier on a bell or terminal start', () => {
    const current: SortStamps = { recentAt: 0, smartTier: 'done', smartAt: 4 }
    expect(classifySortStampEvent(current, { kind: 'bell' }, NOW)).toEqual({
      recentAt: NOW,
      smartTier: 'done',
      smartAt: 4
    })
  })

  it('returns null when nothing changes', () => {
    const current: SortStamps = { recentAt: NOW, smartTier: 'working', smartAt: NOW }
    expect(
      classifySortStampEvent(
        current,
        agentEvent('rest', 'working', [{ phase: 'working', at: NOW }]),
        NOW
      )
    ).toBeNull()
  })
})
