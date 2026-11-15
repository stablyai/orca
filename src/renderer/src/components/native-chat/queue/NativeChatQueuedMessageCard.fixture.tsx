import { defineFixture } from '../../../component-fixtures/component-fixture'
import { NativeChatQueuedMessageCard } from './NativeChatQueuedMessageCard'

export const pendingSteer = defineFixture({
  width: 420,
  render: () => (
    <ul className="native-chat-appearance rounded-md border bg-card p-2">
      <NativeChatQueuedMessageCard
        card={{
          messageId: 'pending-steer',
          position: 1,
          text: 'B: Also check the remote session.',
          state: 'waiting',
          hold: 'steer'
        }}
        chatWorktreeId={null}
        agentWorking
        showsSteerShortcut={false}
        onSteer={() => {}}
        onDelete={() => {}}
      />
    </ul>
  )
})

export const ordinaryQueue = defineFixture({
  width: 420,
  render: () => (
    <ul className="native-chat-appearance rounded-md border bg-card p-2">
      <NativeChatQueuedMessageCard
        card={{
          messageId: 'ordinary-queue',
          position: 1,
          text: 'B: Also check the remote session.',
          state: 'waiting',
          hold: 'turn'
        }}
        chatWorktreeId={null}
        agentWorking
        showsSteerShortcut={false}
        onSteer={() => {}}
        onDelete={() => {}}
      />
    </ul>
  )
})
