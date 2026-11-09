import { defineFixture } from '../../component-fixtures/component-fixture'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { nativeChatStreamingMessage } from '../../../../shared/native-chat/native-chat-streaming'
import { orderNativeChatDisplayMessages } from '../../../../shared/native-chat/transcript/native-chat-message-order'
import { pendingSendsAsMessages } from '../../../../shared/native-chat/transcript/native-chat-pending-sends'
import { MessageRow } from './messages/rows/NativeChatMessageRow'

const history: NativeChatMessage[] = [
  {
    id: 'boundary',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'I am checking how the session is connected.' }],
    timestamp: 100,
    transcriptOrder: 1,
    source: 'transcript'
  },
  {
    id: 'test-input',
    role: 'user',
    blocks: [{ type: 'text', text: 'test' }],
    timestamp: 110,
    transcriptOrder: 2,
    source: 'transcript'
  },
  {
    id: 'test-reply',
    role: 'assistant',
    blocks: [
      { type: 'text', text: 'Received the test message. I am continuing the investigation.' }
    ],
    timestamp: 120,
    transcriptOrder: 3,
    source: 'transcript'
  }
]
const pending = [
  { id: 'first', text: 'Which CLI is this session using?' },
  { id: 'second', text: 'Are you still there?' },
  { id: 'test', text: 'test' }
].map((entry) => ({
  ...entry,
  sentAt: 1_000_000,
  afterMessageId: 'boundary',
  afterMessageTimestamp: 100,
  queuedDuringWorkingEpoch: null
}))

function PendingTranscript() {
  const messages = orderNativeChatDisplayMessages([
    ...history,
    nativeChatStreamingMessage('Checking the latest session state…'),
    ...pendingSendsAsMessages(pending, history, null)
  ])
  return (
    <div className="native-chat-appearance flex flex-col gap-6 p-6">
      {messages.map((message) => (
        <MessageRow
          key={message.id}
          message={message}
          expandSignal={false}
          onScrollMessageToTop={() => {}}
        />
      ))}
    </div>
  )
}

export const desktop = defineFixture({ width: 960, render: () => <PendingTranscript /> })
export const narrow = defineFixture({ width: 390, render: () => <PendingTranscript /> })
