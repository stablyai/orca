import { expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../agent-session/journal/agent-session-journal-types'
import { withNativeChatCutTurnNotices } from './native-chat-cut-turn-notice'

it('adds a notice after a cut turn for a chat whose agent is not known yet', () => {
  const cut: AgentJournalRenderItem = {
    itemId: 'turn',
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: { kind: 'turn', turnId: 't', state: 'interrupted' }
  }
  expect(withNativeChatCutTurnNotices([cut], { agentName: undefined })).toHaveLength(2)
})
