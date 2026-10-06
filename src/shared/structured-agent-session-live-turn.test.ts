import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import {
  statusStructuredAgentSessionToolCall,
  isStructuredAgentSessionThinking
} from './structured-agent-session-live-turn'

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
      kind: 'message',
      role: 'reasoning',
      blocks: [{ type: 'text', text: 'Weighing two approaches' }]
    })

  it('is true while reasoning is the newest thing the turn produced', () => {
    expect(isStructuredAgentSessionThinking({ items: [turnStart, reasoning(2)] })).toBe(true)
  })

  it("reads a reasoning row's own state when its host keeps one", () => {
    const withState = (state: 'running' | 'completed'): AgentJournalRenderItem =>
      item('reasoning-state', 2, {
        kind: 'message',
        role: 'reasoning',
        blocks: [{ type: 'text', text: 'Weighing two approaches' }],
        state,
        ...(state === 'completed' ? { completedAt: 3 } : {})
      })
    expect(isStructuredAgentSessionThinking([turnStart, withState('running')])).toBe(true)
    // Ended reasoning stays the newest row while Claude streams a tool's input after it.
    expect(isStructuredAgentSessionThinking([turnStart, withState('completed')])).toBe(false)
  })

  it('is false once a tool call, a message or a diff lands after the reasoning', () => {
    const after = (body: AgentJournalRenderItem['body']): boolean =>
      isStructuredAgentSessionThinking({ items: [turnStart, reasoning(2), item('after', 3, body)] })
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
    expect(isStructuredAgentSessionThinking({ items: [turnStart] })).toBe(false)
    expect(isStructuredAgentSessionThinking({ items: [] })).toBe(false)
  })

  it('does not read an earlier turn as this one reasoning', () => {
    // The scan stops at this turn's own record, so the previous turn's reasoning
    // cannot leak forward into a turn that has produced nothing yet.
    const newTurn = item('turn-2-start', 2, {
      kind: 'status',
      text: 'Working',
      turnLifecycle: { turnId: 'turn-2', state: 'running' }
    })
    expect(isStructuredAgentSessionThinking({ items: [reasoning(1), newTurn] })).toBe(false)
  })

  it('does not read a completed turn as reasoning during the next pending dispatch', () => {
    const completedTurn = item('turn-1', 1, {
      kind: 'turn',
      turnId: 'turn-1',
      state: 'completed'
    })
    expect(isStructuredAgentSessionThinking({ items: [completedTurn, reasoning(2)] })).toBe(false)
  })

  it('stops at a typed turn item, the carrier this host writes', () => {
    const typedTurn = (sequence: number, turnId: string): AgentJournalRenderItem =>
      item(`turn-${turnId}`, sequence, { kind: 'turn', turnId, state: 'running' })
    expect(
      isStructuredAgentSessionThinking({ items: [typedTurn(1, 'turn-1'), reasoning(2)] })
    ).toBe(true)
    expect(
      isStructuredAgentSessionThinking({ items: [reasoning(1), typedTurn(2, 'turn-2')] })
    ).toBe(false)
  })

  it("reads the host's running turn when the turn's record is above the loaded rows", () => {
    const hostTurn = (state: 'running' | 'completed') => ({
      itemId: 'turn-start',
      observedAt: 1,
      turn: { turnId: 'turn-1', state }
    })
    expect(
      isStructuredAgentSessionThinking({ items: [reasoning(2)], latestTurn: hostTurn('running') })
    ).toBe(true)
    expect(
      isStructuredAgentSessionThinking({ items: [reasoning(2)], latestTurn: hostTurn('completed') })
    ).toBe(false)
    // An older host states nothing, and the loaded rows alone name no turn.
    expect(isStructuredAgentSessionThinking({ items: [reasoning(2)] })).toBe(false)
    // The host's answer outranks a loaded record whose ending revision is off the window.
    expect(
      isStructuredAgentSessionThinking({
        items: [turnStart, reasoning(2)],
        latestTurn: hostTurn('completed')
      })
    ).toBe(false)
  })

  it('lets an unmarked status stay transparent to the latest reasoning state', () => {
    const plan = item('plan', 3, { kind: 'status', text: 'Step 1. Read the file' })
    expect(isStructuredAgentSessionThinking({ items: [turnStart, plan] })).toBe(false)
    expect(isStructuredAgentSessionThinking({ items: [turnStart, reasoning(2), plan] })).toBe(true)
  })

  it.each([
    {
      kind: 'approval' as const,
      title: 'Run the command?',
      detail: null,
      options: [],
      resolution: {
        state: 'pending' as const,
        selectedOptionId: null,
        resolvedBy: null,
        resolvedAt: null
      }
    },
    {
      kind: 'question' as const,
      question: 'Which path?',
      options: [],
      resolution: {
        state: 'pending' as const,
        selectedOptionId: null,
        resolvedBy: null,
        resolvedAt: null
      }
    }
  ])('stops thinking when the turn is waiting on a $kind', (prompt) => {
    expect(
      isStructuredAgentSessionThinking({
        items: [turnStart, reasoning(2), item('prompt', 3, prompt)]
      })
    ).toBe(false)
  })
})

describe("the live-turn readers answer for the session's own agent", () => {
  const turnStart = item('turn-start', 1, {
    kind: 'status',
    text: 'Working',
    turnLifecycle: { turnId: 'turn-1', state: 'running' }
  })
  const spawnCall = item('root-task', 2, {
    kind: 'tool-call',
    name: 'Task',
    input: { description: 'explore' },
    state: 'running'
  })
  const child = (
    itemId: string,
    sequence: number,
    body: AgentJournalRenderItem['body'],
    agentId = 'task-1'
  ): AgentJournalRenderItem => ({ ...item(itemId, sequence, body), agentId })

  it('does not report the parent as thinking because a subagent is reasoning', () => {
    const childReasoning = child('child-reasoning', 3, {
      kind: 'message',
      role: 'reasoning',
      blocks: [{ type: 'text', text: 'Weighing two approaches' }]
    })
    expect(
      isStructuredAgentSessionThinking({ items: [turnStart, spawnCall, childReasoning] })
    ).toBe(false)
  })

  it('still reports the parent as thinking when the parent itself is reasoning', () => {
    const ownReasoning = item('own-reasoning', 3, {
      kind: 'message',
      role: 'reasoning',
      blocks: [{ type: 'text', text: 'Weighing two approaches' }]
    })
    expect(isStructuredAgentSessionThinking({ items: [turnStart, spawnCall, ownReasoning] })).toBe(
      true
    )
  })

  it("reports the parent's own running call while a subagent runs its own", () => {
    const childCall = child('child-grep', 3, {
      kind: 'tool-call',
      name: 'Grep',
      input: { pattern: 'x' },
      state: 'running'
    })
    expect(statusStructuredAgentSessionToolCall([turnStart, spawnCall, childCall])?.name).toBe(
      'Task'
    )
  })

  it('reports nothing running when only a subagent has a live call', () => {
    const childCall = child('child-grep', 2, {
      kind: 'tool-call',
      name: 'Grep',
      input: { pattern: 'x' },
      state: 'running'
    })
    expect(statusStructuredAgentSessionToolCall([turnStart, childCall])).toBeNull()
  })

  it('treats an agent id that failed to resolve as a child, not as the parent', () => {
    // Presence, not truthiness. A truthy test would read the empty id as root
    // and put the child's tool call straight back on the parent's row — the
    // exact defect this attribution exists to remove.
    const unresolved = child(
      'child-grep',
      3,
      { kind: 'tool-call', name: 'Grep', input: { pattern: 'x' }, state: 'running' },
      ''
    )
    expect(statusStructuredAgentSessionToolCall([turnStart, spawnCall, unresolved])?.name).toBe(
      'Task'
    )
  })

  it("reads a row written before linkage existed as the parent's own", () => {
    const legacyChildCall = item('legacy-call', 3, {
      kind: 'tool-call',
      name: 'Grep',
      input: { pattern: 'x' },
      state: 'running'
    })
    expect(
      statusStructuredAgentSessionToolCall([turnStart, spawnCall, legacyChildCall])?.name
    ).toBe('Grep')
  })
})
