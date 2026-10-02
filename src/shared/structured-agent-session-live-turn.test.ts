import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import { statusStructuredAgentSessionToolCall } from './structured-agent-session-live-turn'

function item(
  itemId: string,
  sequence: number,
  body: AgentJournalRenderItem['body']
): AgentJournalRenderItem {
  return { itemId, sequence, revision: 1, observedAt: sequence, body }
}

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
