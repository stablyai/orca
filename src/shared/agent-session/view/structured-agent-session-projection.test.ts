import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../journal/agent-session-journal-types'
import { projectStructuredItemToNativeChat } from './structured-agent-session-projection'

function item(
  itemId: string,
  sequence: number,
  body: AgentJournalRenderItem['body']
): AgentJournalRenderItem {
  return { itemId, sequence, revision: 1, observedAt: sequence, body }
}

describe('structured agent session status projection', () => {
  it('projects an item kind this build does not know to no message, never a text bubble', () => {
    const unknown = item('future', 1, {
      kind: 'future-kind',
      text: 'a newer host wrote this'
    } as unknown as AgentJournalRenderItem['body'])

    expect(projectStructuredItemToNativeChat(unknown)).toBeNull()
  })
})
