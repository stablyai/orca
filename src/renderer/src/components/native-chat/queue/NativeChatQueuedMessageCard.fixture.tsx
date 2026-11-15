import { defineFixture } from '../../../component-fixtures/component-fixture'
import { NativeChatQueuedMessageCard } from './NativeChatQueuedMessageCard'
import type { AgentSessionSteerFallback } from '../../../../../shared/agent-session/requests/agent-session-queued-message-wire'

function fallbackCard(steerFallback: AgentSessionSteerFallback) {
  return defineFixture({
    width: 420,
    render: () => (
      <ul className="native-chat-appearance rounded-md border bg-card p-2">
        <NativeChatQueuedMessageCard
          card={{
            messageId: 'fallback',
            position: 1,
            text: 'B: Also check the remote session.',
            state: 'waiting',
            hold: 'steer',
            steerFallback
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
}

export const providerQueueOnly = fallbackCard('provider-queue-only')
export const codexOptions = fallbackCard('codex-options')
export const codexLegacy = fallbackCard('codex-legacy')

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

export const restartedSteer = defineFixture({
  width: 420,
  render: () => (
    <ul className="native-chat-appearance rounded-md border bg-card p-2">
      <NativeChatQueuedMessageCard
        card={{
          messageId: 'restarted-steer',
          position: 1,
          text: 'B: Also check the remote session.',
          state: 'waiting',
          hold: 'paused',
          pausedReason: 'restarted'
        }}
        chatWorktreeId={null}
        agentWorking={false}
        showsSteerShortcut={false}
        onSteer={() => {}}
        onDelete={() => {}}
      />
    </ul>
  )
})
