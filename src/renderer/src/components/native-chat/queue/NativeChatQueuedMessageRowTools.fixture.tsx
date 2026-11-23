import { defineFixture } from '../../../component-fixtures/component-fixture'
import { nativeChatAppearanceStyle } from '../appearance/native-chat-appearance-style'
import { NativeChatQueuedMessageList } from './NativeChatQueuedMessageList'
import { NativeChatDock } from '../pane/dock/NativeChatDock'
import { NativeChatComposer } from '../composer/NativeChatComposer'
import type { StructuredAgentSessionQueuedMessagesController } from './use-structured-agent-session-queued-messages'
import type { QueuedMessageCard } from '../../../../../shared/agent-session/view/structured-agent-session-queued-cards'
import { QUEUED_MESSAGE_PAUSED_SEND_FAILED } from '../../../../../shared/agent-session/requests/agent-session-queued-message-wire'

// Every row keeps its own Steer at rest; Edit and Delete wait for hover or keyboard focus.
const CARDS: QueuedMessageCard[] = [
  'Rename the settings section to Display.',
  'Then run the unit tests for the color picker and fix what fails.',
  'Last, write a short summary of the change.'
].map((text, i) => ({ messageId: `p${i}`, position: i, state: 'waiting', hold: 'turn', text }))

const noop = async (): Promise<void> => {}

function Queue({ cards }: { cards: QueuedMessageCard[] }) {
  const controller: StructuredAgentSessionQueuedMessagesController = {
    cards,
    queueCapable: true,
    clearCapable: true,
    pause: null,
    resume: async () => true,
    clear: async () => true,
    queuePending: null,
    pending: () => null,
    steer: noop,
    remove: noop,
    editCapable: true,
    editor: undefined,
    edit: noop,
    steerHead: undefined,
    isWorking: true
  }
  return (
    <div
      data-native-chat-root="true"
      className="native-chat-appearance flex flex-col bg-chat-pane"
      style={{ ...nativeChatAppearanceStyle({}), height: 700 }}
    >
      <div className="flex-1 p-4 text-sm text-muted-foreground">The tests pass on this branch.</div>
      <NativeChatDock>
        <NativeChatQueuedMessageList controller={controller} chatWorktreeId={null} />
        <NativeChatComposer
          terminalTabId="row-tools-fixture-tab"
          paneKey="row-tools-fixture-pane"
          targetPtyId={null}
          agent="claude"
        />
      </NativeChatDock>
    </div>
  )
}

export const narrowThreeAtRest = defineFixture({
  width: 380,
  render: () => <Queue cards={CARDS} />
})

export const narrowKeyboardFocus = defineFixture({
  width: 380,
  render: () => <Queue cards={CARDS} />,
  // A focus() with no pointer use matches :focus-visible, as a Tab would.
  interact: (frame) => {
    frame.querySelectorAll<HTMLElement>('li [aria-label="Edit message"]')[1]?.focus()
  }
})

export const narrowFailedRetry = defineFixture({
  width: 380,
  render: () => (
    <Queue
      cards={CARDS.map((card, i) =>
        i === 1
          ? { ...card, hold: 'paused', pausedReason: QUEUED_MESSAGE_PAUSED_SEND_FAILED }
          : card
      )}
    />
  )
})
