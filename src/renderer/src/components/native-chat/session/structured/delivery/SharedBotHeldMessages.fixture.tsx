import { defineFixture } from '../../../../../component-fixtures/component-fixture'
import type { SharedBotHostView } from '../../../../../../../shared/bots/shared-bot-hosts'
import { projectStructuredAgentSessionMessages } from '../../../conversation/projection/structured-agent-session-message-projection'
import { MessageRow } from '../../../messages/rows/NativeChatMessageRow'
import { sharedBotHeldMessages } from './shared-bot-held-messages'

const HOST: SharedBotHostView = {
  environmentId: 'shared-ivy',
  shareId: 'share-ivy',
  botId: 'ivy',
  botName: 'Ivy',
  ownerName: 'Jinwoo Hong',
  link: 'offline',
  holds: true,
  held: [
    {
      clientMessageId: 'held-1',
      sessionId: 'chat-ivy-0001',
      text: 'Can you check whether #40189 fixes the dictation retry on Windows?',
      sentAt: 1,
      state: 'not_sent'
    },
    {
      clientMessageId: 'held-2',
      sessionId: 'chat-ivy-0001',
      text: 'And run the dictation tests on that branch once it does.',
      sentAt: 2,
      state: 'waiting'
    }
  ]
}

function HeldChat(): React.JSX.Element {
  const { messages, notices } = sharedBotHeldMessages(
    HOST,
    'chat-ivy-0001',
    { waiting: (owner) => `Waiting for ${owner}’s computer`, notSent: 'Not sent' },
    () => {}
  )
  return (
    <div className="native-chat-appearance space-y-4 p-4">
      {projectStructuredAgentSessionMessages([], messages, []).map((message) => (
        <MessageRow
          key={message.id}
          message={message}
          expandSignal={false}
          onScrollMessageToTop={() => {}}
          deliveryNotice={notices.get(message.id)}
        />
      ))}
    </div>
  )
}

/** A teammate's messages to a shared agent while its computer is away: one refused, one waiting. */
export const heldMessages = defineFixture({ width: 560, render: () => <HeldChat /> })
