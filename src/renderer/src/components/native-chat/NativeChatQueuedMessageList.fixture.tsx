import { defineFixture } from '../../component-fixtures/component-fixture'
import { NativeChatQueuedMessageList } from './NativeChatQueuedMessageList'
import type { StructuredAgentSessionQueuedMessagesController } from './use-structured-agent-session-queued-messages'

const controller: StructuredAgentSessionQueuedMessagesController = {
  cards: ['Review the plan later', 'Actually, check the failing test now'].map(
    (text, position) => ({
      messageId: `queued-${position}`,
      position,
      text,
      state: 'waiting',
      hold: 'turn'
    })
  ),
  queueCapable: true,
  clearCapable: true,
  editCapable: false,
  editor: undefined,
  pause: null,
  queuePending: null,
  pending: () => null,
  steer: async () => {},
  remove: async () => {},
  edit: async () => {},
  clear: async () => true,
  resume: async () => false,
  steerHead: () => true,
  steerLast: () => true,
  isWorking: true
}

export const latestPreview = defineFixture({
  width: 640,
  render: () => (
    <div data-native-chat-root>
      <div data-native-chat-steer-preview="steer-queued">
        <NativeChatQueuedMessageList controller={controller} chatWorktreeId={null} />
      </div>
    </div>
  )
})
