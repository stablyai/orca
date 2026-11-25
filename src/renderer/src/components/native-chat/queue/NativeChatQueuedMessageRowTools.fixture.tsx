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

function Queue({ cards, fontSize }: { cards: QueuedMessageCard[]; fontSize?: number }) {
  const controller: StructuredAgentSessionQueuedMessagesController = {
    cards,
    queueCapable: true,
    holds: () => false,
    agentMail: [],
    agentMailEditable: () => false,
    mailLeads: false,
    stopping: false,
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
      style={{
        ...nativeChatAppearanceStyle(fontSize ? { nativeChatAppearance: { fontSize } } : {}),
        height: 700
      }}
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

// One row each: failed with an image and a clipped line, a queued row with images, an image row
// the host cannot edit, and a plain row; the tool row's glyphs should sit evenly apart.
const IMAGE_CARDS: QueuedMessageCard[] = [
  {
    ...CARDS[0],
    text: 'Use the attached mock for the settings header and match its spacing on narrow panes.',
    hold: 'paused',
    pausedReason: QUEUED_MESSAGE_PAUSED_SEND_FAILED,
    images: [{ type: 'image-ref', path: '/tmp/settings-mock.png', alt: 'Settings mock' }]
  },
  {
    ...CARDS[1],
    images: [
      { type: 'image-ref', path: '/tmp/before.png', alt: 'Before' },
      { type: 'image-ref', path: '/tmp/after.png', alt: 'After' }
    ]
  },
  {
    ...CARDS[2],
    text: 'Compare these.',
    notEditable: true,
    images: [{ type: 'image-ref', path: '/tmp/chart.png', alt: 'Chart' }]
  },
  { messageId: 'p3', position: 3, state: 'waiting', hold: 'turn', text: 'Then push.' }
]

export const narrowImagesAtRest = defineFixture({
  width: 380,
  render: () => <Queue cards={IMAGE_CARDS} />
})

export const narrowImagesFailedToolsShown = defineFixture({
  width: 380,
  render: () => <Queue cards={IMAGE_CARDS} />,
  interact: (frame) => {
    frame.querySelector<HTMLElement>('li [aria-label="Edit message"]')?.focus()
  }
})

export const narrowImagesToolsShown = defineFixture({
  width: 380,
  render: () => <Queue cards={IMAGE_CARDS} />,
  interact: (frame) => {
    frame.querySelectorAll<HTMLElement>('li [aria-label="Edit message"]')[1]?.focus()
  }
})

export const narrowNoEditToolsShown = defineFixture({
  width: 380,
  render: () => <Queue cards={IMAGE_CARDS} />,
  interact: (frame) => {
    frame.querySelectorAll<HTMLElement>('li [aria-label="Delete"]')[2]?.focus()
  }
})

export const narrowFailedToolsShown = defineFixture({
  width: 380,
  render: () => (
    <Queue
      cards={CARDS.map((card, i) =>
        i === 1
          ? { ...card, hold: 'paused', pausedReason: QUEUED_MESSAGE_PAUSED_SEND_FAILED }
          : card
      )}
    />
  ),
  interact: (frame) => {
    frame.querySelectorAll<HTMLElement>('li [aria-label="Edit message"]')[1]?.focus()
  }
})

// The smallest text size shrinks the chat's spacing unit; every target in the row keeps 24px.
export const narrowImagesSmallestText = defineFixture({
  width: 380,
  render: () => <Queue cards={IMAGE_CARDS} fontSize={12} />
})

export const narrowFailedSmallestText = defineFixture({
  width: 380,
  render: () => (
    <Queue
      fontSize={12}
      cards={CARDS.map((card, i) =>
        i === 1
          ? { ...card, hold: 'paused', pausedReason: QUEUED_MESSAGE_PAUSED_SEND_FAILED }
          : card
      )}
    />
  )
})

// Tab onto the image count of a row whose text fits: its ring sits beside its neighbors' boxes.
export const narrowImageCountFocused = defineFixture({
  width: 380,
  render: () => <Queue cards={IMAGE_CARDS} />,
  interact: (frame) => {
    frame.querySelectorAll<HTMLElement>('li [role="img"]')[2]?.focus()
  }
})
