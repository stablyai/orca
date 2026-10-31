import { defineFixture } from '../../component-fixtures/component-fixture'
import { NativeChatChildTranscriptFrame } from './NativeChatChildTranscriptFrame'
import type { NativeChatLiveSession } from './native-chat-live-session-contract'

const session: NativeChatLiveSession = {
  sessionId: 'fixture-child-history',
  agent: 'codex',
  status: 'ready',
  messages: [
    {
      id: 'original-assignment',
      role: 'user',
      source: 'transcript',
      timestamp: 1,
      from: { kind: 'agent', senders: [], orchestration: null },
      blocks: [
        {
          type: 'text',
          text: 'Review mobile history loading. Preserve the reading position and include the original task in the child conversation.'
        }
      ]
    },
    {
      id: 'child-reply',
      role: 'assistant',
      source: 'transcript',
      timestamp: 2,
      blocks: [
        {
          type: 'text',
          text: 'I traced the pagination flow and checked how earlier messages are retained. The original assignment is visible above this reply.'
        }
      ]
    }
  ],
  hasMore: false,
  loadingEarlier: false,
  olderHistoryGeneration: 0,
  loadEarlier: async () => 'exhausted',
  readPhase: 'ready',
  readCurrent: true
}

export const retainedAssignment = defineFixture({
  width: 720,
  render: () => (
    <div className="native-chat-appearance flex h-96 flex-col bg-chat-canvas">
      <NativeChatChildTranscriptFrame
        child={{ agentId: 'fixture-child', label: 'Review mobile history' }}
        parent={null}
        session={session}
        onBack={() => {}}
        isVisible
      />
    </div>
  )
})
