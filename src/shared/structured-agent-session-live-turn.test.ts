import { describe, expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THINKING_PRESENTATION,
  type AgentJournalRenderItem
} from './agent-session-journal-types'
import { isStructuredAgentSessionThinking } from './structured-agent-session-live-turn'

function item(
  itemId: string,
  sequence: number,
  body: AgentJournalRenderItem['body']
): AgentJournalRenderItem {
  return { itemId, sequence, revision: 1, observedAt: sequence, body }
}

describe('isStructuredAgentSessionThinking', () => {
  const turnStart = item('turn-start', 1, {
    kind: 'status',
    text: 'Working',
    turnLifecycle: { turnId: 'turn-1', state: 'running' }
  })
  const reasoning = (sequence: number): AgentJournalRenderItem =>
    item(`reasoning-${sequence}`, sequence, {
      kind: 'status',
      text: 'Weighing two approaches',
      presentation: AGENT_JOURNAL_THINKING_PRESENTATION
    })

  it('is true while reasoning is the newest thing the turn produced', () => {
    expect(isStructuredAgentSessionThinking([turnStart, reasoning(2)])).toBe(true)
  })

  it('is false once a tool call, a message or a diff lands after the reasoning', () => {
    const after = (body: AgentJournalRenderItem['body']): boolean =>
      isStructuredAgentSessionThinking([turnStart, reasoning(2), item('after', 3, body)])
    expect(after({ kind: 'tool-call', name: 'shell', input: null, state: 'running' })).toBe(false)
    expect(
      after({ kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Here you go' }] })
    ).toBe(false)
    expect(
      after({
        kind: 'diff',
        path: 'src/a.ts',
        patch: { head: '@@', byteLength: 2, digest: 'd', truncated: false }
      })
    ).toBe(false)
  })

  it('is false when a turn produced no reasoning at all', () => {
    expect(isStructuredAgentSessionThinking([turnStart])).toBe(false)
    expect(isStructuredAgentSessionThinking([])).toBe(false)
  })

  it('does not read an earlier turn as this one reasoning', () => {
    // The scan stops at this turn's own record, so the previous turn's reasoning
    // cannot leak forward into a turn that has produced nothing yet.
    const newTurn = item('turn-2-start', 2, {
      kind: 'status',
      text: 'Working',
      turnLifecycle: { turnId: 'turn-2', state: 'running' }
    })
    expect(isStructuredAgentSessionThinking([reasoning(1), newTurn])).toBe(false)
  })

  it('stops at a typed turn item, the carrier this host writes', () => {
    const typedTurn = (sequence: number, turnId: string): AgentJournalRenderItem =>
      item(`turn-${turnId}`, sequence, { kind: 'turn', turnId, state: 'running' })
    expect(isStructuredAgentSessionThinking([typedTurn(1, 'turn-1'), reasoning(2)])).toBe(true)
    expect(isStructuredAgentSessionThinking([reasoning(1), typedTurn(2, 'turn-2')])).toBe(false)
  })

  it('does not treat an unmarked status row, such as a Codex plan, as reasoning', () => {
    const plan = item('plan', 2, { kind: 'status', text: 'Step 1. Read the file' })
    expect(isStructuredAgentSessionThinking([turnStart, plan])).toBe(false)
  })
})
