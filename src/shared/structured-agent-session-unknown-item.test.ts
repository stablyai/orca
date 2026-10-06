// An item of a kind this build does not know is kept and drawn by nobody: no client renders it,
// and nothing the host or a client decides from items (a running turn, a pending prompt, status)
// reads it.

import { expect, it } from 'vitest'
import { isAdmissibleAgentJournalItemBody } from './agent-session-journal-schemas'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import { activeStructuredAgentSessionTurnId } from './structured-agent-session-live-turn'
import {
  projectStructuredAgentSessionStatusSummary,
  projectStructuredItemsToNativeChat
} from './structured-agent-session-projection'

function renderItem(sequence: number, body: unknown): AgentJournalRenderItem {
  // Admitted through the catch-all, though the journal's body type names only known kinds.
  if (!isAdmissibleAgentJournalItemBody(body)) {
    throw new Error('the journal admits this body')
  }
  return { itemId: `item-${sequence}`, revision: 1, sequence, observedAt: sequence, body }
}

const ITEMS = [
  renderItem(1, { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Ship it' }] }),
  renderItem(2, { kind: 'turn', turnId: 'turn-1', state: 'completed' }),
  renderItem(3, { kind: 'plan-card', state: 'running', resolution: { state: 'pending' } })
]

it('draws nothing for an item of a kind this build does not know', () => {
  expect(projectStructuredItemsToNativeChat(ITEMS).map((message) => message.id)).toEqual(['item-1'])
})

it('takes no turn, prompt or work from it', () => {
  expect(activeStructuredAgentSessionTurnId(ITEMS)).toBeNull()
  expect(projectStructuredAgentSessionStatusSummary(ITEMS)).toMatchObject({
    status: 'idle',
    latestPrompt: 'Ship it'
  })
})
