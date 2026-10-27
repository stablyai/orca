import { describe, expect, it } from 'vitest'
import type {
  AgentJournalMessageItem,
  AgentJournalMessageState,
  AgentJournalRenderItem
} from './agent-session-journal-types'
import { projectStructuredItemToNativeChat } from './structured-agent-session-projection'

function item(
  itemId: string,
  sequence: number,
  body: AgentJournalRenderItem['body']
): AgentJournalRenderItem {
  return { itemId, sequence, revision: 1, observedAt: sequence, body }
}

describe('structured reasoning projection', () => {
  it('preserves reasoning text and identity for desktop and mobile consumers', () => {
    const blocks = [{ type: 'text' as const, text: 'Inspecting the request' }]
    expect(
      projectStructuredItemToNativeChat(
        item('reasoning-1', 2, {
          kind: 'message',
          role: 'reasoning',
          blocks
        })
      )
    ).toEqual({
      id: 'reasoning-1',
      role: 'reasoning',
      blocks,
      timestamp: 2,
      journalPosition: { sequence: 2, index: 0 },
      source: 'transcript'
    })
  })

  it('carries a reasoning row lifecycle, and reads a state it cannot name as completed', () => {
    const blocks = [{ type: 'text' as const, text: 'Inspecting' }]
    const project = (body: Pick<AgentJournalMessageItem, 'state' | 'completedAt'>) =>
      projectStructuredItemToNativeChat(
        item('reasoning-2', 3, { kind: 'message', role: 'reasoning', blocks, ...body })
      )
    expect(project({ state: 'running' })).toMatchObject({ state: 'running' })
    expect(project({ state: 'completed', completedAt: 9 })).toMatchObject({
      state: 'completed',
      completedAt: 9
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a newer host's state, which this build's type cannot name.
    expect(project({ state: 'paused' as AgentJournalMessageState })).toMatchObject({
      state: 'completed'
    })
    expect(project({})).not.toHaveProperty('state')
  })
})
