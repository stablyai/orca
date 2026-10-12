// The desktop chat answers only the prompts the host says still wait on the person: one an agent
// that has ended raised gets no card, and an older host, which names none, keeps today's rule.

import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../../../shared/structured-agent-session-reducer'
import { pendingStructuredSessionPrompts } from './structured-agent-session-message-projection'
import { structuredAttentionReadObservation } from './structured-attention-read-observation'

function approval(itemId: string, sequence: number): AgentJournalRenderItem {
  return {
    itemId,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: {
      kind: 'approval',
      title: 'Run command?',
      detail: null,
      options: [{ id: 'yes', label: 'Allow' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    }
  }
}

const ITEMS = [approval('live-prompt', 1), approval('dead-prompt', 2)]
const ids = (items: AgentJournalRenderItem[]) => items.map((item) => item.itemId)

describe('the prompt cards a desktop chat offers', () => {
  it('are the ones the host names', () => {
    expect(ids(pendingStructuredSessionPrompts(ITEMS, ['live-prompt']))).toEqual(['live-prompt'])
    expect(pendingStructuredSessionPrompts(ITEMS, [])).toEqual([])
  })

  it('are every pending prompt when an older host names none', () => {
    expect(ids(pendingStructuredSessionPrompts(ITEMS))).toEqual(['live-prompt', 'dead-prompt'])
  })
})

describe('what marks a chat read', () => {
  it('changes when the host stops naming a prompt, with no row changing', () => {
    const ask: AgentJournalRenderItem = {
      itemId: 'ask',
      revision: 1,
      sequence: 0,
      observedAt: 0,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'go' }] }
    }
    const state = { ...EMPTY_STRUCTURED_AGENT_SESSION, items: [ask, ...ITEMS] }
    const named = structuredAttentionReadObservation({
      ...state,
      actionablePromptIds: ['live-prompt']
    })
    const ended = structuredAttentionReadObservation({ ...state, actionablePromptIds: [] })
    expect(ended).not.toBe(named)
  })
})
