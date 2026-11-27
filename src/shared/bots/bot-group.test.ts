import { expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../agent-session/journal/agent-session-journal-types'
import { botGroupTurnOperation, indexBotGroupJournal } from './bot-group'

it('attributes the turn to its opener when item wakes join the running turn', () => {
  const turnItemId = 'claude:session:turn'
  const turnScope = { kind: 'turn', turnItemId } as const
  const items: AgentJournalRenderItem[] = [
    {
      itemId: 'orca:opener',
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Review the item.' }] }
    },
    {
      itemId: turnItemId,
      revision: 1,
      sequence: 2,
      observedAt: 2,
      body: { kind: 'turn', turnId: 'turn', state: 'running', userItemId: 'orca:opener' }
    },
    {
      itemId: 'claude:session:reply',
      revision: 1,
      sequence: 3,
      observedAt: 3,
      turnScope,
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Reviewing.' }] }
    },
    {
      itemId: 'orca:wake-send',
      revision: 1,
      sequence: 4,
      observedAt: 4,
      turnScope,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Item updated.' }] }
    }
  ]
  const accepted: Omit<AgentJournalSubmission, 'clientMessageId'> = {
    fence: 1,
    payloadFingerprint: '',
    dispatchState: 'accepted',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: 1
  }
  const snapshot = {
    items,
    submissions: [
      { ...accepted, clientMessageId: 'opener', providerItemId: 'claude:session:prompt' },
      {
        ...accepted,
        clientMessageId: 'wake-send',
        queuedMessageId: 'wake',
        answeredInTurn: { turnItemId, via: 'steer' as const }
      },
      {
        ...accepted,
        clientMessageId: 'second-wake',
        answeredInTurn: { turnItemId, via: 'steer' as const }
      }
    ]
  }
  const read = indexBotGroupJournal(snapshot)

  expect(read('opener')?.map((item) => item.itemId)).toContain('claude:session:reply')
  expect(read('wake')).toBeNull()
  expect(read('second-wake')).toBeNull()
  expect(botGroupTurnOperation({ ...snapshot, items: [] }, turnItemId)).toBeNull()
  expect(botGroupTurnOperation(snapshot, turnItemId)).toBe('opener')
})
