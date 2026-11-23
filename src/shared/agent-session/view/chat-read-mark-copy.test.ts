import { expect, it } from 'vitest'
import { copyChatReadMarksToConversationKeys } from './chat-read-mark-copy'

const LEAF_1 = 'e8bc163c-82ee-4187-a328-8c7d4ac636db'
const LEAF_2 = '2b8ea975-8113-41ae-a25c-feb50cbe084a'

it('adds a missing conversation key from a tab key and keeps every existing key', () => {
  const tabA = `agent-chat-tab-v1-1111:${LEAF_1}`
  const tabB = `structured-agent-session-old:${LEAF_2}`
  const conversation2 = `structured-agent-session-sess-2:${LEAF_2}`
  expect(
    copyChatReadMarksToConversationKeys(
      { acknowledgedAgentsByPaneKey: { [tabA]: 100, [tabB]: 200, [conversation2]: 300 } },
      [
        { id: 'agent-chat-tab-v1-1111', contentType: 'agent-session', entityId: 's1' },
        { id: 'structured-agent-session-old', contentType: 'agent-session', entityId: 'sess-2' }
      ]
    )
  ).toEqual({
    acknowledgedAgentsByPaneKey: {
      [tabA]: 100,
      [tabB]: 200,
      [conversation2]: 300,
      [`structured-agent-session-s1:${LEAF_1}`]: 100
    }
  })
})
